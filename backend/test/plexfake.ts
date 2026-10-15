// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-memory fake of the Plex Media Server HTTP API, seeded from REAL PMS answers (test/plex/fixtures, recorded by the block 16
 * spike against PMS 1.43). It reproduces the shapes the sync relies on: listings strip streams and reduce tags to {tag}, totalSize
 * only with paging parameters, multi-fetch details with Extras/Guid/Marker on request, X-Plex-Token required (401 otherwise).
 * Tests mutate the library through the helpers (setRating, addMovie, remove …).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import type { KV } from '../src/kv.js';
import { PlexClient } from '../src/plex/client.js';
import { migratePlex } from '../src/plex/migrations.js';
import { PlexMediaServer, type PlexPlayback } from '../src/plex/service.js';

export const PLEX_URL = 'http://plex.test:32400';
export const PLEX_TOKEN = 'plex-admin-token-SECRET-1234';
/** INTERNAL_SECRET of the fake setups (signs chapter still URLs) */
export const PLEX_TEST_SECRET = 'x'.repeat(32); // fixed HMAC key for tests only

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'plex', 'fixtures');
export const fixture = (name: string): any => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'));
const meta = (name: string): Array<Record<string, any>> => fixture(name).MediaContainer.Metadata ?? [];
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;

export interface PlexCall { method: string; path: string; search: string; token?: string; headers: Record<string, string> }

const TYPE_NUM: Record<string, number> = { movie: 1, show: 2, season: 3, episode: 4 };
const TAG_FIELDS = ['Genre', 'Role', 'Director', 'Writer', 'Producer', 'Country', 'Collection', 'Label'];

export class PlexFake {
  sections: Array<Record<string, any>>;
  /** full (detail-form) metadata by ratingKey */
  items = new Map<string, Record<string, any>>();
  /** owner ratingKey -> extras (clip metadata) */
  extras = new Map<string, Array<Record<string, any>>>();
  /** collection ratingKey -> member ratingKeys */
  members = new Map<string, string[]>();
  calls: PlexCall[] = [];
  /** GET /status/sessions answer (Block 22; hand-written in PMS's shape, see fixtures/status_sessions.json) */
  statusSessions: Record<string, any> = clone(fixture('status_sessions'));
  /** ratingKeys of PUT /library/metadata/<rk>/refresh calls */
  refreshed: string[] = [];
  /** next status for paths matching a regex (e.g. simulate an outage) */
  fail: { re: RegExp; status: number } | null = null;
  /** GET /identity's machineIdentifier (fork Task 8: another value is another Plex server) */
  machineIdentifier: string = fixture('identity').MediaContainer.machineIdentifier;
  /**
   * Tokens of a shared (non-owner) account and the status PMS gives them on admin-only paths (/status/sessions): library reads work,
   * the sessions answer 401 or 403 (setup probe: a warning, not a refusal). Any other token than PLEX_TOKEN or these gets 401 everywhere.
   */
  sharedTokens = new Map<string, 401 | 403>();
  /** fork: GET /photo/:/transcode answer (Block 23 phase 3 cover wall); default a small JPEG */
  photo: { status?: number; type?: string; bytes?: Uint8Array; length?: string } = {};
  private nextKey = 100;

  constructor() {
    this.sections = clone(fixture('sections').MediaContainer.Directory);
    const batch = new Map(meta('metadata_batch').map((m) => [String(m.ratingKey), m]));
    const m1 = { ...meta('movie1_detail')[0], ...pick(batch.get('1'), ['contentRating', 'Collection']) };
    const m2 = { ...meta('movie2_hevc_detail')[0], ...pick(batch.get('2'), ['contentRating', 'Collection']) };
    for (const m of [m1, m2, meta('show_detail')[0]!, ...meta('show_seasons'), ...meta('episodes_all')]) this.items.set(String(m.ratingKey), clone(m));
    // the episode detail fixture carries streams; the listing form of the others does not
    const ep = meta('ep_detail')[0]!;
    this.items.set(String(ep.ratingKey), { ...this.items.get(String(ep.ratingKey)), ...clone(ep) });
    // show: 2 seasons, give seasons their section (the listing fixture has it on the container only)
    for (const m of this.items.values()) m.librarySectionID ??= m.type === 'movie' ? 1 : 2;
    const coll = clone(fixture('collections_list').MediaContainer.Metadata[0]);
    coll.librarySectionID = 1;
    this.items.set(String(coll.ratingKey), coll);
    this.members.set(String(coll.ratingKey), meta('collection_children').map((m) => String(m.ratingKey)));
    this.extras.set('1', clone(meta('extras_trailer')));
  }

  // ---------------------------------------------------------------- mutations (tests)

  setRating(rk: string | number, rating: string | undefined) {
    const m = this.items.get(String(rk))!;
    if (rating === undefined) delete m.contentRating;
    else m.contentRating = rating; // like PMS: updatedAt does NOT change on a metadata edit
  }

  /** a movie in section 1 (or another movie section) */
  addMovie(o: { title: string; rating?: string; year?: number; genres?: string[]; actors?: Array<{ id: number; tag: string; role?: string }>; directors?: Array<{ id: number; tag: string }>; writers?: Array<{ id: number; tag: string }>; labels?: string[]; sectionId?: number; guids?: string[]; addedAt?: number; summary?: string; audienceRating?: number; studio?: string }): string {
    const rk = String(this.nextKey++);
    const base = clone(this.items.get('1')!);
    const m: Record<string, any> = {
      ...base, ratingKey: rk, key: `/library/metadata/${rk}`, guid: `local://${rk}`, title: o.title, year: o.year ?? 2020, librarySectionID: o.sectionId ?? 1,
      addedAt: o.addedAt ?? 1791900000 + Number(rk), updatedAt: 1791900000 + Number(rk), thumb: `/library/metadata/${rk}/thumb/1791900000`, art: `/library/metadata/${rk}/art/1791900000`,
      summary: o.summary ?? '',
    };
    if (o.rating === undefined) delete m.contentRating;
    else m.contentRating = o.rating;
    delete m.Collection;
    if (o.genres) m.Genre = o.genres.map((g, i) => ({ id: 1000 + i + Number(rk) * 10, filter: `genre=${1000 + i}`, tag: g }));
    if (o.actors) m.Role = o.actors.map((a) => ({ id: a.id, filter: `actor=${a.id}`, tag: a.tag, role: a.role ?? '' }));
    if (o.directors) m.Director = o.directors.map((a) => ({ id: a.id, filter: `director=${a.id}`, tag: a.tag }));
    if (o.writers) m.Writer = o.writers.map((a) => ({ id: a.id, filter: `writer=${a.id}`, tag: a.tag }));
    if (o.labels) m.Label = o.labels.map((t, i) => ({ id: 2000 + i + Number(rk) * 10, tag: t }));
    if (o.guids) m.Guid = o.guids.map((id) => ({ id }));
    if (o.audienceRating !== undefined) m.audienceRating = o.audienceRating;
    if (o.studio) m.studio = o.studio;
    this.items.set(rk, m);
    return rk;
  }

  /** a show with one season and n episodes (own section or section 2) */
  addShow(o: { title: string; rating?: string; episodes?: number; sectionId?: number; episodeRating?: string; guids?: string[]; aired?: string }): { show: string; season: string; episodes: string[] } {
    const show = String(this.nextKey++);
    const season = String(this.nextKey++);
    const sec = o.sectionId ?? 2;
    const s: Record<string, any> = { ...clone(this.items.get('3')!), ratingKey: show, key: `/library/metadata/${show}/children`, title: o.title, librarySectionID: sec, thumb: `/library/metadata/${show}/thumb/1`, updatedAt: 1, addedAt: 1791900000 };
    if (o.rating === undefined) delete s.contentRating;
    else s.contentRating = o.rating;
    if (o.guids) s.Guid = o.guids.map((id) => ({ id }));
    this.items.set(show, s);
    this.items.set(season, { ...clone(this.items.get('4')!), ratingKey: season, parentRatingKey: show, title: 'Season 1', index: 1, librarySectionID: sec });
    const episodes: string[] = [];
    for (let n = 1; n <= (o.episodes ?? 2); n++) {
      const rk = String(this.nextKey++);
      const e: Record<string, any> = {
        ...clone(this.items.get('6')!), ratingKey: rk, key: `/library/metadata/${rk}`, parentRatingKey: season, grandparentRatingKey: show, grandparentTitle: o.title,
        index: n, parentIndex: 1, librarySectionID: sec, title: `Episode ${n}`, addedAt: 1791900000 + n, updatedAt: 1791900000 + n,
        ...(o.aired ? { originallyAvailableAt: o.aired } : {}),
      };
      if (o.episodeRating === undefined) delete e.contentRating;
      else e.contentRating = o.episodeRating;
      this.items.set(rk, e);
      episodes.push(rk);
    }
    return { show, season, episodes };
  }

  /**
   * The REAL movie with chapters (fixture movie_chapters_detail: PMS 1.43, includeChapters=1, chapter thumbnails generated:
   * Chapter[{tag, index, startTimeOffset, thumb: /library/media/11/chapterImages/N}]). ratingKey 15, media 11.
   */
  addChapterMovie(o: { thumbs?: boolean } = {}): string {
    const m = clone(meta('movie_chapters_detail')[0]!);
    m.librarySectionID = 1;
    if (o.thumbs === false) for (const c of m.Chapter) delete c.thumb;
    this.items.set(String(m.ratingKey), m);
    return String(m.ratingKey);
  }

  /**
   * Overrides the first video / audio streams of an item's first media version (stream keys as PMS sends them: width, height,
   * DOVIPresent, colorTrc, channels, displayTitle …). Not recorded: the spike media were SD stereo / mono only.
   */
  setStreams(rk: string | number, video: Record<string, unknown> | null, audio: Array<Record<string, unknown>> = []) {
    const m = this.items.get(String(rk))!;
    const part = m.Media[0].Part[0];
    const others = (part.Stream ?? []).filter((s: Record<string, any>) => s.streamType !== 1 && s.streamType !== 2);
    part.Stream = [...(video ? [{ id: 9000, streamType: 1, codec: 'hevc', ...video }] : []), ...audio.map((a, i) => ({ id: 9001 + i, streamType: 2, codec: 'eac3', ...a })), ...others];
  }

  /** a collection (section 1 by default) with the given members, in this order (Plex's own collection order) */
  addCollection(title: string, members: string[], sectionId = 1): string {
    const rk = String(this.nextKey++);
    const base = clone(fixture('collections_list').MediaContainer.Metadata[0]);
    this.items.set(rk, { ...base, ratingKey: rk, key: `/library/collections/${rk}/children`, guid: `collection://c-${rk}`, title, librarySectionID: sectionId,
      childCount: members.length, thumb: `/library/collections/${rk}/composite/1791800022?width=400&height=600`, addedAt: 1791800022, updatedAt: 1791800022 });
    this.members.set(rk, [...members]);
    return rk;
  }

  addSection(title: string, type: 'movie' | 'show'): number {
    const id = Math.max(...this.sections.map((s) => Number(s.key))) + 1;
    this.sections.push({ ...clone(this.sections[0]!), key: String(id), type, title, uuid: `uuid-${id}` });
    return id;
  }

  remove(rk: string | number) {
    const k = String(rk);
    this.items.delete(k);
    for (const [ck, list] of this.members) this.members.set(ck, list.filter((x) => x !== k));
    for (const m of [...this.items.values()]) if (String(m.parentRatingKey) === k || String(m.grandparentRatingKey) === k) this.items.delete(String(m.ratingKey));
  }

  /** bumps updatedAt like PMS does on a re-scan / new file */
  touch(rk: string | number) {
    const m = this.items.get(String(rk))!;
    m.updatedAt = Number(m.updatedAt ?? 0) + 100;
  }

  // ---------------------------------------------------------------- HTTP

  private listForm(m: Record<string, any>, guids: boolean): Record<string, any> {
    const o = clone(m);
    for (const f of TAG_FIELDS) if (Array.isArray(o[f])) o[f] = o[f].map((t: Record<string, any>) => ({ tag: t.tag }));
    for (const md of o.Media ?? []) for (const p of md.Part ?? []) delete p.Stream;
    if (!guids) delete o.Guid;
    delete o.Extras;
    delete o.Marker;
    delete o.Chapter;
    delete o.Field;
    delete o.Location;
    return o;
  }

  private detailForm(m: Record<string, any>, q: URLSearchParams): Record<string, any> {
    const o = clone(m);
    if (q.get('includeGuids') !== '1') delete o.Guid;
    if (q.get('includeMarkers') !== '1') delete o.Marker;
    if (q.get('includeChapters') !== '1') delete o.Chapter;
    const ex = this.extras.get(String(m.ratingKey)) ?? [];
    if (q.get('includeExtras') === '1') o.Extras = ex.length ? { size: ex.length, Metadata: clone(ex) } : { size: 0 };
    return o;
  }

  private page(list: Array<Record<string, any>>, q: URLSearchParams, extra: Record<string, unknown> = {}) {
    const start = q.get('X-Plex-Container-Start');
    const size = q.get('X-Plex-Container-Size');
    if (start === null && size === null) return { MediaContainer: { size: list.length, ...extra, Metadata: list } };
    const s = Number(start ?? 0);
    const n = Number(size ?? list.length);
    const slice = list.slice(s, s + n);
    return { MediaContainer: { size: slice.length, totalSize: list.length, offset: s, ...extra, ...(slice.length ? { Metadata: slice } : {}) } };
  }

  handle(method: string, url: URL, headers: Record<string, string>): { status: number; json?: unknown; text?: string; raw?: Uint8Array; type?: string; length?: string } {
    const path = url.pathname;
    const q = url.searchParams;
    if (this.fail && this.fail.re.test(path)) return { status: this.fail.status };
    if (path === '/identity') return { status: 200, json: { MediaContainer: { ...fixture('identity').MediaContainer, machineIdentifier: this.machineIdentifier } } };
    const shared = this.sharedTokens.get(headers['X-Plex-Token'] ?? '');
    if (headers['X-Plex-Token'] !== PLEX_TOKEN && !shared) return { status: 401, text: '<html>401 Unauthorized</html>' };
    if (shared && path === '/status/sessions') return { status: shared, text: `<html>${shared}</html>` };
    const r = /^\/library\/metadata\/(\d+)\/refresh$/.exec(path);
    if (r && method === 'PUT') {
      if (!this.items.has(r[1]!)) return { status: 404 };
      this.refreshed.push(r[1]!);
      return { status: 200, text: '' };
    }
    if (method !== 'GET') return { status: 404 };
    if (path === '/status/sessions') return { status: 200, json: this.statusSessions };
    if (path === '/photo/:/transcode') { // fork: the photo transcoder (only an item's own poster path is ever asked for)
      if (!/^\/library\/metadata\/(\d+)\/thumb/.test(q.get('url') ?? '')) return { status: 400 };
      return { status: this.photo.status ?? 200, raw: this.photo.bytes ?? new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), type: this.photo.type ?? 'image/jpeg', ...(this.photo.length ? { length: this.photo.length } : {}) };
    }
    if (path === '/library/sections') return { status: 200, json: { MediaContainer: { size: this.sections.length, Directory: this.sections } } };
    let m = /^\/library\/sections\/(\d+)\/all$/.exec(path);
    if (m) {
      const sid = Number(m[1]);
      if (!this.sections.some((s) => Number(s.key) === sid)) return { status: 404 };
      const sec = this.sections.find((s) => Number(s.key) === sid)!;
      const type = Number(q.get('type') ?? (sec.type === 'movie' ? 1 : 2));
      const list = [...this.items.values()]
        .filter((x) => Number(x.librarySectionID) === sid && TYPE_NUM[x.type] === type)
        // PMS filter syntax `updatedAt>>=<epoch s>` (at or after)
        .filter((x) => q.get('updatedAt>>') === null || Number(x.updatedAt ?? 0) >= Number(q.get('updatedAt>>')))
        .sort((a, b) => Number(a.ratingKey) - Number(b.ratingKey))
        .map((x) => this.listForm(x, q.get('includeGuids') === '1'));
      return { status: 200, json: this.page(list, q, { librarySectionID: sid }) };
    }
    m = /^\/library\/sections\/(\d+)\/collections$/.exec(path);
    if (m) {
      const sid = Number(m[1]);
      const list = [...this.items.values()].filter((x) => x.type === 'collection' && Number(x.librarySectionID) === sid).map((x) => this.listForm(x, false));
      return { status: 200, json: this.page(list, q) };
    }
    m = /^\/library\/collections\/(\d+)\/children$/.exec(path);
    if (m) {
      const list = (this.members.get(m[1]!) ?? []).map((k) => this.items.get(k)).filter(Boolean).map((x) => this.listForm(x!, false));
      return { status: 200, json: this.page(list, q) };
    }
    m = /^\/library\/metadata\/([\d,]+)$/.exec(path);
    if (m) {
      const list = m[1]!.split(',').map((k) => this.items.get(k)).filter(Boolean).map((x) => this.detailForm(x!, q));
      if (!list.length) return { status: 404 };
      return { status: 200, json: { MediaContainer: { size: list.length, Metadata: list } } };
    }
    return { status: 404 };
  }

  readonly fetch: typeof fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = { ...(init.headers as Record<string, string> | undefined) };
    this.calls.push({ method, path: url.pathname, search: url.search, token: headers['X-Plex-Token'], headers });
    const r = this.handle(method, url, headers);
    if (r.json !== undefined) return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
    if (r.raw) return new Response(Buffer.from(r.raw), { status: r.status, headers: { 'content-type': r.type ?? 'application/octet-stream', ...(r.length ? { 'content-length': r.length } : {}) } });
    return new Response(r.text ?? null, { status: r.status, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
}

function pick(o: Record<string, any> | undefined, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, clone(o![k])]));
}

/** A PlexMediaServer against the fake, on the test pool (fork migrations run on first use). */
export function plexServer(pool: pg.Pool, kv: KV, fake = new PlexFake(), opts: { playback?: (svc: PlexMediaServer) => PlexPlayback; secret?: string } = {}): { ms: PlexMediaServer; fake: PlexFake } {
  const ms = new PlexMediaServer({
    client: new PlexClient(PLEX_URL, PLEX_TOKEN, fake.fetch),
    db: pool, kv, migrate: () => migratePlex(pool), websocket: false, secret: opts.secret ?? PLEX_TEST_SECRET,
    ...(opts.playback ? { playback: opts.playback } : {}),
  });
  return { ms, fake };
}
