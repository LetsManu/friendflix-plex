// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Access control for Plex: FriendFlix reaches Plex with ONE admin token, so Plex cannot enforce per-profile visibility. Every
 * browse query runs over the Postgres mirror with the predicate built here (library sections of the role, content-rating age
 * cap, kids "block unrated"); item() answers 404 for anything outside it. Fail closed throughout: an identity without a policy
 * row sees nothing, a disabled one sees nothing, and for a capped identity an unrated OR unknown rating is blocked.
 */
import type { Db } from '../db.js';

// ---------------------------------------------------------------- content rating -> age

/** Age value for "rating present but not understood": counts as unrated, i.e. blocked for capped identities. */
export const UNKNOWN_AGE = -1;

const UNRATED = new Set(['nr', 'not rated', 'unrated', 'ur', 'none', 'n/a']);

/** US MPAA + TV Parental Guidelines (also used when no country prefix is present). Ages as Jellyfin scores them. */
const US: Record<string, number> = {
  g: 0, pg: 10, 'pg-13': 13, r: 17, 'nc-17': 18, x: 18,
  'tv-y': 0, 'tv-y7': 7, 'tv-y7-fv': 7, 'tv-g': 0, 'tv-pg': 10, 'tv-14': 14, 'tv-ma': 17,
};
const COUNTRY: Record<string, Record<string, number>> = {
  us: US,
  gb: { u: 0, uc: 0, pg: 8, '12': 12, '12a': 12, '15': 15, '18': 18, r18: 18 },
  ie: { g: 0, pg: 8, '12a': 12, '15a': 15, '16': 16, '18': 18 },
  de: { 'fsk-0': 0, 'fsk-6': 6, 'fsk-12': 12, 'fsk-16': 16, 'fsk-18': 18, bpjm: 18 },
  at: {},
  ch: {},
  au: { g: 0, pg: 8, m: 15, 'ma15+': 15, 'ma 15+': 15, 'r18+': 18, 'r 18+': 18, 'x18+': 18, e: 0, c: 0, p: 0 },
  nz: { g: 0, pg: 8, m: 16, r13: 13, r15: 15, r16: 16, r18: 18, r: 18 },
  ca: { g: 0, pg: 8, '14a': 14, '18a': 18, r: 18, c: 0, c8: 8, '14+': 14, '18+': 18 },
  fr: { u: 0, tp: 0, '10': 10, '12': 12, '16': 16, '18': 18 },
  nl: { al: 0, '6': 6, '9': 9, '12': 12, '14': 14, '16': 16, '18': 18 },
  br: { l: 0, er: 0, livre: 0 },
  es: { a: 0, tp: 0, apta: 0 },
  jp: { g: 0, pg12: 12, 'pg-12': 12, 'r15+': 15, 'r18+': 18 },
  kr: { all: 0 },
};

/**
 * Plex `contentRating` -> minimum age. null = unrated (empty, NR, Not Rated …), UNKNOWN_AGE = a rating string this map does
 * not know (treated like unrated: fail closed). Accepts Plex's country-prefixed form ("de/12", "gb/15", "us/PG-13") and
 * plain values ("PG-13", "TV-MA", "FSK 16", "12", "16+").
 */
export function ratingAge(raw: string | null | undefined): number | null {
  const s0 = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s0) return null;
  if (UNRATED.has(s0)) return null;
  const m = /^([a-z]{2})\/(.+)$/.exec(s0);
  const cc = m ? m[1]! : '';
  const r = (m ? m[2]! : s0).trim();
  if (!r || UNRATED.has(r)) return null;
  const table = cc ? COUNTRY[cc] : undefined;
  const norm = r.replace(/\s+/g, '-');
  if (table && (r in table || norm in table)) return table[r] ?? table[norm]!;
  // numeric systems (de/at/ch/fr/nl/…: "12", "FSK 12", "ab 12", "12+", "16 Jahre")
  const n = /^(?:fsk|ab|age|k|pegi|bbfc)?[ -]*(\d{1,2})(?:a|\+| ?j(?:ahre)?\.?)?$/.exec(r);
  if (n) {
    const age = Number(n[1]);
    if (age >= 0 && age <= 21) return age;
  }
  if (!cc || cc === 'us') {
    if (r in US) return US[r]!;
    if (norm in US) return US[norm]!;
  }
  return UNKNOWN_AGE;
}

const loggedUnknown = new Set<string>();

/**
 * Refreshes plex_ratings (every distinct rating string of the mirror -> age) from ratingAge() and recomputes the per-item
 * ages. all=true recomputes every row (startup: the map in this file may have changed). Unknown ratings are logged once.
 */
export async function refreshAges(db: Db, log?: { warn(o: unknown, msg?: string): void }, all = false): Promise<void> {
  const r = await db.query<{ rating: string }>(
    all
      ? `select distinct x.rating from (select content_rating rating from plex_items union select inherit_rating from plex_items) x where x.rating is not null`
      : `select distinct x.rating from (select content_rating rating from plex_items union select inherit_rating from plex_items) x
         where x.rating is not null and not exists (select 1 from plex_ratings r where r.rating = x.rating)`,
  );
  if (r.rows.length) {
    const rows = r.rows.map((x) => ({ rating: x.rating, age: ratingAge(x.rating) }));
    for (const x of rows) {
      if (x.age === UNKNOWN_AGE && !loggedUnknown.has(x.rating)) {
        loggedUnknown.add(x.rating);
        log?.warn({ rating: x.rating }, 'plex: unknown content rating, treated as unrated (blocked for age-capped profiles)');
      }
    }
    await db.query(
      `insert into plex_ratings(rating, age) select x.rating, x.age from jsonb_to_recordset($1::jsonb) as x(rating text, age smallint)
       on conflict (rating) do update set age = excluded.age`,
      [JSON.stringify(rows)],
    );
  }
  // season/episode inherit the show's rating, a clip (trailer / extra) its owner's
  await db.query(
    `update plex_items i set inherit_rating = p.content_rating from plex_items p
     where i.type in ('season', 'episode', 'clip')
       and p.rating_key = case when i.type = 'episode' then coalesce(i.grandparent_key, i.parent_key) else i.parent_key end
       and i.inherit_rating is distinct from p.content_rating`,
  );
  await db.query(
    `with a as (
       select i.rating_key,
         case when coalesce(i.content_rating, '') = '' then null else coalesce(ro.age, ${UNKNOWN_AGE}) end own_age,
         case when coalesce(i.inherit_rating, '') = '' then null else coalesce(ri.age, ${UNKNOWN_AGE}) end inh_age,
         i.type
       from plex_items i
       left join plex_ratings ro on ro.rating = i.content_rating
       left join plex_ratings ri on ri.rating = i.inherit_rating
     ), b as (
       select rating_key,
         case when type in ('season', 'episode', 'clip') then inh_age else own_age end req,
         case when type in ('season', 'episode', 'clip') then own_age else null end opt
       from a
     )
     update plex_items i set age_req = b.req, age_opt = b.opt from b
     where b.rating_key = i.rating_key and (i.age_req is distinct from b.req or i.age_opt is distinct from b.opt)`,
  );
  // a rating that is no longer used anywhere: drop it (keeps the table small)
  if (all) await db.query('delete from plex_ratings r where not exists (select 1 from plex_items i where i.content_rating = r.rating or i.inherit_rating = r.rating)');
}

// ---------------------------------------------------------------- policies

/** What plex_media_policies holds for one identity (see admin.applyPolicy). */
export interface PlexPolicy {
  identity: string;
  /** role library names (matched case-insensitively against Plex section titles); null = all */
  libraries: string[] | null;
  /** null = no age cap */
  maxAge: number | null;
  /** FriendFlix item types hidden when unrated (kids profiles: Movie, Series, Trailer) */
  blockUnrated: string[];
  disabled: boolean;
}

/** A policy resolved against the current sections, ready for SQL. sections: null = all. */
export interface Access {
  identity: string;
  sections: number[] | null;
  maxAge: number | null;
  /** Plex item types hidden when unrated */
  blockTypes: string[];
}

const BLOCK_TYPES: Record<string, string[]> = {
  movie: ['movie'], series: ['show', 'season', 'episode'], season: ['season', 'episode'], episode: ['episode'],
  trailer: ['clip'], video: ['clip'], boxset: [], collection: [],
};

/** Policy row -> Access; no policy or disabled => no section at all (nothing visible). */
export function resolveAccess(p: PlexPolicy | null, sections: Array<{ id: number; title: string }>, identity: string): Access {
  if (!p || p.disabled) return { identity, sections: [], maxAge: 0, blockTypes: [] };
  let ids: number[] | null = null;
  if (p.libraries) {
    const want = new Set(p.libraries.map((n) => n.trim().toLowerCase()));
    ids = sections.filter((s) => want.has(s.title.trim().toLowerCase())).map((s) => s.id);
  }
  const blockTypes = [...new Set(p.blockUnrated.flatMap((t) => BLOCK_TYPES[t.toLowerCase()] ?? []))];
  return { identity, sections: ids, maxAge: p.maxAge, blockTypes };
}

/** Pushes a parameter and returns its placeholder. */
export type Param = (v: unknown) => string;

export function paramList(start: unknown[] = []): { params: unknown[]; p: Param } {
  const params = [...start];
  return { params, p: (v) => (params.push(v), `$${params.length}`) };
}

/**
 * SQL condition: may `a` (a plex_items alias) be seen with this access? Collections are visible when at least one member is.
 * The age predicate for season/episode/clip uses the inherited (show / owner) rating, plus the item's own one when present.
 */
export function visibleSql(acc: Access, a: string, p: Param, depth = 0): string {
  const parts: string[] = [];
  if (acc.sections !== null) parts.push(`${a}.section_id = any(${p(acc.sections)}::int[])`);
  if (acc.maxAge !== null) {
    const m = p(acc.maxAge);
    parts.push(`(${a}.type = 'collection' or (${a}.age_req between 0 and ${m} and (${a}.type in ('movie', 'show') or ${a}.age_opt is null or ${a}.age_opt between 0 and ${m})))`);
  }
  if (acc.blockTypes.length) parts.push(`not (${a}.type = any(${p(acc.blockTypes)}::text[]) and coalesce(${a}.age_req, -1) < 0)`);
  if (depth === 0) {
    const c = `c${a}`;
    parts.push(`(${a}.type <> 'collection' or exists (select 1 from plex_collection_items ci${a} join plex_items ${c} on ${c}.rating_key = ci${a}.item_key
      where ci${a}.collection_key = ${a}.rating_key and ${c}.type <> 'collection' and ${visibleSql(acc, c, p, 1)}))`);
  }
  return parts.length ? `(${parts.join(' and ')})` : 'true';
}

/** Loads the policy of one identity (null = none: nothing visible). */
export async function loadPolicy(db: Db, identity: string): Promise<PlexPolicy | null> {
  const r = await db.query<{ libraries: string[] | null; max_age: number | null; block_unrated: string[]; disabled: boolean }>(
    'select libraries, max_age, block_unrated, disabled from plex_media_policies where identity_id = $1', [identity]);
  const row = r.rows[0];
  if (!row) return null;
  return { identity, libraries: row.libraries, maxAge: row.max_age, blockUnrated: row.block_unrated ?? [], disabled: row.disabled };
}
