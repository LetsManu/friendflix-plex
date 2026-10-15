// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fork: the cover wall of the in-app login (upstream Block 23 phase 3, MediaAdmin.loginArtIds / posterThumb) on Plex.
 *
 * Candidates come from the library mirror (plex_items: movies and shows with a poster), never from a live Plex listing. The
 * allow-list (loginArt.ts LOGIN_ART_RATINGS) is checked here, exactly and case-sensitively, against the item's OWN Plex
 * `contentRating`. Plex stores two spellings:
 * - plain values, as Plex's US-centric agents write them: "G", "PG", "TV-PG", "TV-Y7", "U", "12A", "12", "PG-13" …
 *   They are compared with the allow-list as they are.
 * - country-prefixed values "<cc>/<value>", with a lower-case two-letter country ("de/12", "gb/12A", "gb/PG", "us/PG-13").
 *   They are rewritten to the allow-list's "<CC>-<value>" form ("de/12" -> "DE-12", "gb/U" -> "GB-U") and compared exactly;
 *   "us/<value>" is compared as the plain US value ("us/PG" -> "PG"). Nothing else is translated: "de/FSK 12" becomes
 *   "DE-FSK 12" (not on the list), "fr/12", "at/6", "au/PG", "nl/AL" are not on the list either, so they fail closed.
 * Unrated items (no contentRating, empty) never come back. As a second guard, the fork's own age map (access.ts ratingAge) must
 * place the raw value at 0 to 12 (an unknown value is -1 there and fails), so a future allow-list entry that Plex spells with a
 * different meaning cannot slip through. Consequence: a plain "U" (no country) is dropped, "gb/U" is kept.
 */
import type { Db } from '../db.js';
import { ratingAge } from './access.js';
import type { PlexClient } from './client.js';
import { encodePlexId, plexKey } from './ids.js';

/** highest age a cover-wall rating may map to (the allow-list stops at FSK 12 and equivalents) */
const MAX_ART_AGE = 12;
/** one oversized poster must not bloat the cache (same cap as the Jellyfin implementation) */
export const POSTER_MAX_BYTES = 2 * 1024 * 1024;
/** a mirror thumb path that may be handed to the photo transcoder: the item's own poster, nothing else */
const THUMB_RE = /^\/library\/metadata\/\d{1,12}\/thumb(?:\/\d{1,12})?$/;

/** The allow-list spelling of a Plex `contentRating` ("de/12" -> "DE-12", "us/PG" -> "PG", "TV-PG" -> "TV-PG"); null when unrated. */
export function plexArtSpelling(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const m = /^([a-z]{2})\/(.+)$/.exec(raw);
  if (!m) return raw;
  return m[1] === 'us' ? m[2]! : `${m[1]!.toUpperCase()}-${m[2]!}`;
}

/** Whether a Plex `contentRating` may appear on the cover wall: its spelling is on the allow-list AND it means age 12 or less. */
export function plexArtAllowed(raw: string | null | undefined, allow: ReadonlySet<string>): boolean {
  const s = plexArtSpelling(raw);
  if (s === null || !allow.has(s)) return false;
  const age = ratingAge(raw); // null = unrated, UNKNOWN_AGE (-1) = not understood: both fail closed
  return age !== null && age >= 0 && age <= MAX_ART_AGE;
}

/** Random movie / show ids (FriendFlix 32-hex form) with a poster whose own rating passes plexArtAllowed. */
export async function plexLoginArtIds(db: Db, q: { ratings: readonly string[]; limit: number }): Promise<string[]> {
  const allow = new Set(q.ratings);
  const limit = Math.max(0, Math.min(Math.trunc(q.limit), 200));
  if (!allow.size || !limit) return [];
  const spellings = await db.query<{ r: string }>(
    `select distinct content_rating r from plex_items where type in ('movie', 'show') and content_rating is not null and content_rating <> '' and thumb is not null`);
  const ok = spellings.rows.map((x) => x.r).filter((r) => plexArtAllowed(r, allow));
  if (!ok.length) return [];
  const r = await db.query<{ rating_key: string; content_rating: string }>(
    `select rating_key, content_rating from plex_items
     where type in ('movie', 'show') and content_rating = any($1::text[]) and thumb is not null
     order by random() limit $2`, [ok, limit]);
  // checked again on each row: the list above is the only way in
  return r.rows.filter((x) => plexArtAllowed(x.content_rating, allow)).map((x) => encodePlexId('item', String(x.rating_key)));
}

/**
 * A poster scaled by Plex's photo transcoder to `maxWidth` (admin token in the request header, never in the URL or the answer);
 * null for an unknown id, an item without a poster, a non-image answer, or more than POSTER_MAX_BYTES.
 */
export async function plexPosterThumb(db: Db, client: PlexClient, id: string, maxWidth: number): Promise<{ bytes: Uint8Array; type: 'image/jpeg' | 'image/webp' } | null> {
  const rk = plexKey(id);
  if (!rk) return null;
  const row = (await db.query<{ thumb: string | null }>(`select thumb from plex_items where rating_key = $1 and type in ('movie', 'show')`, [rk])).rows[0];
  const thumb = row?.thumb;
  if (!thumb || !THUMB_RE.test(thumb)) return null;
  const w = Math.max(16, Math.min(Math.trunc(maxWidth) || 200, 1000));
  const query = new URLSearchParams({ url: thumb, width: String(w), height: String(w * 4), minSize: '0', upscale: '0', quality: '70' });
  const res = await client.fetch(`/photo/:/transcode?${query.toString()}`, { headers: { Accept: 'image/jpeg,image/webp' }, redirect: 'manual' });
  const drop = async () => { await res.body?.cancel().catch(() => undefined); return null; };
  if (!res.ok) return drop();
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'image/jpeg' && type !== 'image/webp') return drop();
  if (Number(res.headers.get('content-length') ?? 0) > POSTER_MAX_BYTES) return drop();
  if (!res.body) return null;
  // read with a running cap: a missing or wrong content-length must not let a huge body into memory
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > POSTER_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  if (!size) return null;
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.byteLength; }
  return { bytes, type };
}
