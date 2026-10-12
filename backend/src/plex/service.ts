/**
 * FriendFlix for Plex: `PlexMediaServer implements MediaServer`.
 *
 * Plex is reached with ONE admin token, so Plex itself knows nothing about FriendFlix accounts and profiles. Instead:
 * - identities are synthetic (plex_identities; users/profiles.jellyfin_user_id hold their ids), their role / kids policy lives
 *   in plex_media_policies (admin.applyPolicy);
 * - every browse call answers from the Postgres mirror (sync.ts) with the identity's access predicate (access.ts) applied in SQL;
 *   item() is 404 for anything the identity may not see;
 * - played / resume / favourites live in plex_userdata (userdata.ts), never in Plex.
 * Playback (decision/transcode, direct play, subtitles, trickplay, downloads) is a separate delegate (`PlexPlayback`); until it is
 * plugged in, those calls fail with MediaError 501.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../db.js';
import type { KV } from '../kv.js';
import type {
  ChapterDto, ClipTranscode, DownloadQuality, DownloadSourceDto, ExternalSession, IdentityPolicy, ItemCreditsDto, ItemDto, ItemMediaTraits, ItemQuery, ItemStreams, ItemTraits, MediaAdmin,
  MediaCapabilities, MediaCredentials, MediaRuntime, MediaServer, MediaTraits, MediaUser, PersonDto, PlaybackDto, PlaybackOptions, PlaybackReport, Segment, SegmentType,
  SubtitleHit, TrackList, TrickplayDto,
} from '../media/types.js';
import { loadPolicy, paramList, refreshAges, resolveAccess, visibleSql, type Access, type Param } from './access.js';
import { PlexError, type PlexClient } from './client.js';
import { chapterDtos, plexTraits, type MirrorChapter } from './depth.js';
import { plexTypes, sectionDto, toItemDto, type ItemRow } from './dto.js';
import { decodePlexId, encodePlexId, plexKey } from './ids.js';
import { PlexSync } from './sync.js';
import * as ud from './userdata.js';

/** Playback side of the Plex implementation (plugged in by the playback module). */
export interface PlexPlayback {
  mediaFetch(user: MediaUser, path: string, init?: RequestInit): Promise<Response>;
  clipTranscode(user: MediaUser, info: PlaybackDto, o: ClipTranscode): Promise<{ path: string; playSessionId: string }>;
  stopEncoding(user: MediaUser, playSessionId: string): Promise<void>;
  playbackInfo(user: MediaUser, itemId: string, opts: PlaybackOptions): Promise<PlaybackDto>;
  playMeta(user: MediaUser, itemId: string): Promise<{ positionTicks: number; trickplay: (mediaSourceId: string) => TrickplayDto | undefined } | null>;
  downloadSource(user: MediaUser, itemId: string, opts: { quality: DownloadQuality; audioIndex?: number; maxHeight?: number | null; maxBitrate?: number | null }): Promise<DownloadSourceDto>;
  preparePlayback?(user: MediaUser, info: PlaybackDto, opts: PlaybackOptions): Promise<PlaybackDto>;
  subtitleStream(user: MediaUser, itemId: string, mediaSourceId: string, streamIndex: number, format: 'vtt'): Promise<Response>;
  /** optional override of the default report() (user data only) */
  report?(user: MediaUser, r: PlaybackReport): Promise<void>;
}

const notImplemented = (what: string) => new PlexError(501, `Plex: ${what} not implemented`);

export interface PlexDeps {
  client: PlexClient;
  db: Db;
  kv: KV;
  /** runs the fork migrations once (plex/migrations.ts); every DB-using call awaits it */
  migrate: () => Promise<void>;
  /** builds the playback delegate (it may use the service's own helpers) */
  playback?: (svc: PlexMediaServer) => PlexPlayback;
  /** websocket change feed in start() (default on) */
  websocket?: boolean;
  /** INTERNAL_SECRET: signs chapter still URLs (verified by the gateway); without it chapters come without stills */
  secret?: string;
}

export const ITEM_MEMO_TTL_MS = 10_000;
const ITEM_MEMO_MAX = 2000;
const ACCESS_TTL_MS = 5_000;
const PEOPLE_KINDS = ['actor', 'director', 'writer', 'producer'];
const PERSON_TYPE: Record<string, string> = { actor: 'Actor', director: 'Director', writer: 'Writer', producer: 'Producer' };
/** a series counts as continuing while an episode premiered within this many days (Plex has no series status) */
const CONTINUING_DAYS = 60;
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const cloneItem = (i: ItemDto): ItemDto => ({ ...i, genres: [...i.genres], ...(i.imageTags ? { imageTags: { ...i.imageTags } } : {}) });

const SORT: Record<string, string> = {
  sortname: 'lower(coalesce(i.title_sort, i.title))',
  name: 'lower(coalesce(i.title_sort, i.title))',
  datecreated: 'i.added_at',
  premieredate: 'i.originally_available',
  productionyear: 'i.year',
  communityrating: 'coalesce(i.audience_rating, i.critic_rating)',
  criticrating: 'i.critic_rating',
  playcount: 'coalesce(ud.play_count, 0)',
  dateplayed: 'ud.last_played',
  runtime: 'i.duration_ms',
  random: 'random()',
};

interface ListOpts {
  where: string[];
  order?: string;
  limit?: number;
  offset?: number;
  total?: boolean;
}

export class PlexMediaServer implements MediaServer {
  readonly kind = 'plex';
  readonly admin: MediaAdmin;
  readonly sync: PlexSync;
  readonly client: PlexClient;
  readonly db: Db;
  private readonly kv: KV;
  private readonly playback: PlexPlayback;
  private readonly websocket: boolean;
  private readonly secret: string | undefined;
  private initP: Promise<void> | null = null;
  private readonly migrateFn: () => Promise<void>;
  private readonly accessMemo = new Map<string, { exp: number; p: Promise<Access> }>();
  private readonly itemMemo = new Map<string, { exp: number; p: Promise<ItemDto> }>();
  private sectionsMemo: { exp: number; p: Promise<Array<{ id: number; title: string; type: string }>> } | null = null;
  private flagTimer: NodeJS.Timeout | null = null;
  /** feature flags learned from the mirror (capabilities) */
  private flags = { markers: false, bif: false, chapters: false };

  constructor(d: PlexDeps) {
    this.client = d.client;
    this.db = d.db;
    this.kv = d.kv;
    this.migrateFn = d.migrate;
    this.websocket = d.websocket ?? true;
    this.secret = d.secret;
    this.sync = new PlexSync(d.client, d.db, () => this.ready(), async () => {
      this.forgetItems();
      this.sectionsMemo = null;
      this.accessMemo.clear();
      await this.refreshFlags().catch(() => undefined);
    });
    this.admin = this.makeAdmin();
    this.playback = d.playback?.(this) ?? this.stubPlayback();
  }

  /** Honest capabilities: skip segments only when Plex delivered markers, trickplay when BIF index files exist, chapters when any video has some. */
  get capabilities(): MediaCapabilities {
    return {
      segments: new Set<SegmentType>(this.flags.markers ? ['intro', 'outro'] : []),
      trickplay: this.flags.bif, upcoming: false, subtitleSearch: false, webhooks: false, changeFeed: true, planB: false, subtitleExtract: true,
      chapters: this.flags.chapters,
    };
  }

  /** Fork migrations, once (a failure is retried by the next call). */
  ready(): Promise<void> {
    if (!this.initP) {
      this.initP = this.migrateFn().catch((e) => {
        this.initP = null;
        throw e;
      });
    }
    return this.initP;
  }

  private async q<T extends Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
    await this.ready();
    return (await this.db.query<T>(sql, params)).rows;
  }

  // ---------------------------------------------------------------- access

  private sections(): Promise<Array<{ id: number; title: string; type: string }>> {
    const now = Date.now();
    if (this.sectionsMemo && this.sectionsMemo.exp > now) return this.sectionsMemo.p;
    const p = this.q<{ section_id: number; title: string; type: string }>('select section_id, title, type from plex_sections order by section_id')
      .then((r) => r.map((s) => ({ id: s.section_id, title: s.title, type: s.type })));
    this.sectionsMemo = { exp: now + ACCESS_TTL_MS, p };
    p.catch(() => {
      if (this.sectionsMemo?.p === p) this.sectionsMemo = null;
    });
    return p;
  }

  /** The identity's resolved access (memoised 5 s, dropped by every policy write). */
  access(user: MediaUser): Promise<Access> {
    const id = user.jellyfin_user_id;
    const now = Date.now();
    const hit = this.accessMemo.get(id);
    if (hit && hit.exp > now) return hit.p;
    const p = (async () => {
      await this.ready();
      const [pol, secs] = await Promise.all([loadPolicy(this.db, id), this.sections()]);
      return resolveAccess(pol, secs, id);
    })();
    this.accessMemo.set(id, { exp: now + ACCESS_TTL_MS, p });
    p.catch(() => this.accessMemo.delete(id));
    return p;
  }

  private dropAccess(identity?: string) {
    if (identity === undefined) this.accessMemo.clear();
    else this.accessMemo.delete(identity);
    this.forgetItems(identity);
  }

  /** The columns toItemDto() reads, for alias i (needs the identity as parameter `idp`). */
  private selectSql(acc: Access, p: Param, idp: string): string {
    return `select i.rating_key, i.section_id, i.type, i.parent_key, i.grandparent_key, i.title, i.summary, i.year, to_char(i.originally_available, 'YYYY-MM-DD') originally_available,
        i.content_rating, i.inherit_rating, i.audience_rating, i.critic_rating, i.duration_ms, i.idx, i.parent_idx, i.child_count, i.leaf_count,
        i.added_at, i.thumb, i.art, i.logo, i.grandparent_thumb, i.parent_thumb, i.extra_type,
        sh.title show_title, sh.thumb show_thumb,
        (select coalesce(array_agg(t.tag order by t.pos), '{}') from plex_tags t where t.rating_key = i.rating_key and t.kind = 'genre') genres,
        (select count(*) from plex_items x where x.type = 'clip' and x.parent_key = i.rating_key and x.extra_type = 'trailer') trailer_count,
        ud.played ud_played, ud.favorite ud_favorite, ud.position_ticks ud_position, ud.last_played ud_last_played,
        g.ep_total, g.ep_played, g.ep_last_played,
        case when i.type = 'show' then (select max(e.added_at) from plex_items e where e.type = 'episode' and e.grandparent_key = i.rating_key) end last_added,
        case when i.type = 'collection' then (select count(*) from plex_collection_items cm join plex_items m on m.rating_key = cm.item_key
          where cm.collection_key = i.rating_key and ${visibleSql(acc, 'm', p, 1)}) end member_count,
        case when i.type = 'collection' then (select fm.rating_key from plex_collection_items cf join plex_items fm on fm.rating_key = cf.item_key
          where cf.collection_key = i.rating_key and fm.thumb is not null and ${visibleSql(acc, 'fm', p, 1)}
          order by lower(coalesce(fm.title_sort, fm.title)), fm.rating_key limit 1) end first_member
      from plex_items i
      left join plex_items sh on sh.rating_key = case when i.type = 'episode' then i.grandparent_key when i.type = 'season' then i.parent_key end
      left join plex_userdata ud on ud.identity_id = ${idp} and ud.rating_key = i.rating_key
      left join lateral (
        select count(*) ep_total, count(*) filter (where u.played) ep_played, max(u.last_played) ep_last_played
        from plex_items e left join plex_userdata u on u.identity_id = ${idp} and u.rating_key = e.rating_key
        where i.type in ('show', 'season') and e.type = 'episode' and (e.grandparent_key = i.rating_key or e.parent_key = i.rating_key)
          and ${visibleSql(acc, 'e', p, 1)}
      ) g on true`;
  }

  /** Visible items of `user` matching `where` (conditions / order on alias i, ud (user data), g (episode counts)), as DTOs. */
  private async rows(user: MediaUser, build: (p: Param, acc: Access) => ListOpts): Promise<{ items: ItemDto[]; total: number }> {
    const acc = await this.access(user);
    const { params, p } = paramList();
    const idp = p(acc.identity);
    const o = build(p, acc);
    const where = [visibleSql(acc, 'i', p), ...o.where];
    const base = `${this.selectSql(acc, p, idp)} where ${where.join(' and ')}`;
    const offset = o.offset ? Math.max(0, Math.floor(o.offset)) : 0;
    const sql = `${base.replace(/^select /, `select ${o.total ? 'count(*) over() total_count, ' : ''}`)}
      ${o.order ? `order by ${o.order}` : ''} ${o.limit !== undefined ? `limit ${Math.max(0, Math.floor(o.limit))}` : ''} ${offset ? `offset ${offset}` : ''}`;
    const rows = await this.q<ItemRow & { total_count?: string }>(sql, params);
    let total = rows[0]?.total_count !== undefined ? Number(rows[0].total_count) : rows.length;
    // a page past the end has no row to carry count(*) over(): count separately instead of answering total = 0
    if (o.total && !rows.length && offset > 0) total = Number((await this.q<{ n: string }>(`select count(*) n from (${base}) x`, params))[0]?.n ?? 0);
    return { items: rows.map(toItemDto), total };
  }

  /** Rating key of a visible item of the given types, or null. */
  private async visibleKey(user: MediaUser, id: string, types?: string[]): Promise<string | null> {
    const rk = plexKey(id, 'item');
    if (!rk) return null;
    const acc = await this.access(user);
    const { params, p } = paramList();
    const r = await this.q<{ rating_key: string; type: string }>(
      `select i.rating_key, i.type from plex_items i where i.rating_key = ${p(rk)} ${types ? `and i.type = any(${p(types)}::text[])` : ''} and ${visibleSql(acc, 'i', p)}`, params);
    return r[0] ? String(r[0].rating_key) : null;
  }

  private async mustSee(user: MediaUser, id: string, types?: string[]): Promise<string> {
    const k = await this.visibleKey(user, id, types);
    if (!k) throw new PlexError(404, 'Plex: item not found');
    return k;
  }

  // ---------------------------------------------------------------- credentials / raw media

  /**
   * What the gateway gets for a session: NOT a Plex token (the gateway holds PLEX_TOKEN in its own env). `token` is the
   * FriendFlix identity id (no secret; the gateway authorizes every item via /internal/authz/item), deviceId the portal device.
   */
  async mediaAuth(user: MediaUser): Promise<MediaCredentials> {
    return { token: user.jellyfin_user_id, deviceId: `ff-${user.id}` };
  }

  planBAuthHeader(): string {
    throw new PlexError(501, 'Plan B is not supported with Plex');
  }

  mediaFetch(user: MediaUser, path: string, init?: RequestInit) { return this.playback.mediaFetch(user, path, init); }
  clipTranscode(user: MediaUser, info: PlaybackDto, o: ClipTranscode) { return this.playback.clipTranscode(user, info, o); }
  stopEncoding(user: MediaUser, playSessionId: string) { return this.playback.stopEncoding(user, playSessionId); }
  playbackInfo(user: MediaUser, itemId: string, opts: PlaybackOptions) { return this.playback.playbackInfo(user, itemId, opts); }
  playMeta(user: MediaUser, itemId: string) { return this.playback.playMeta(user, itemId); }
  downloadSource(user: MediaUser, itemId: string, opts: { quality: DownloadQuality; audioIndex?: number; maxHeight?: number | null; maxBitrate?: number | null }) {
    return this.playback.downloadSource(user, itemId, opts);
  }
  subtitleStream(user: MediaUser, itemId: string, mediaSourceId: string, streamIndex: number, format: 'vtt') {
    return this.playback.subtitleStream(user, itemId, mediaSourceId, streamIndex, format);
  }
  preparePlayback = (user: MediaUser, info: PlaybackDto, opts: PlaybackOptions): Promise<PlaybackDto> =>
    this.playback.preparePlayback ? this.playback.preparePlayback(user, info, opts) : Promise.resolve(info);

  private stubPlayback(): PlexPlayback {
    return {
      mediaFetch: async () => { throw notImplemented('mediaFetch'); },
      clipTranscode: async () => { throw notImplemented('clipTranscode'); },
      stopEncoding: async () => undefined,
      playbackInfo: async () => { throw notImplemented('playbackInfo'); },
      playMeta: async (user, itemId) => {
        try {
          return { positionTicks: (await this.item(user, itemId)).positionTicks, trickplay: () => undefined };
        } catch {
          return null;
        }
      },
      downloadSource: async () => { throw notImplemented('downloadSource'); },
      subtitleStream: async () => new Response(null, { status: 501 }),
    };
  }

  /** Mirror lookup for the playback module: media/parts/streams (no file paths) of a visible item; 404 otherwise. */
  async mediaOf(user: MediaUser, id: string): Promise<{ ratingKey: string; type: string; durationMs: number | null; media: Array<Record<string, any>> }> {
    const rk = await this.mustSee(user, id);
    const r = await this.q<{ type: string; duration_ms: string | null; media: Array<Record<string, any>> | null }>('select type, duration_ms, media from plex_items where rating_key = $1', [rk]);
    return { ratingKey: rk, type: r[0]!.type, durationMs: r[0]!.duration_ms === null ? null : Number(r[0]!.duration_ms), media: r[0]!.media ?? [] };
  }

  // ---------------------------------------------------------------- browse

  async views(user: MediaUser): Promise<ItemDto[]> {
    const acc = await this.access(user);
    const secs = await this.sections();
    return secs
      .filter((s) => acc.sections === null || acc.sections.includes(s.id))
      .map((s) => sectionDto({ section_id: s.id, title: s.title, type: s.type }));
  }

  async items(user: MediaUser, q: ItemQuery): Promise<{ items: ItemDto[]; total: number }> {
    let parentCond: string | null = null;
    if (q.parentId) {
      const d = decodePlexId(q.parentId);
      if (!d) return { items: [], total: 0 };
      if (d.kind === 'section') {
        const acc = await this.access(user);
        if (acc.sections !== null && !acc.sections.includes(Number(d.value))) return { items: [], total: 0 };
        parentCond = `i.section_id = ${Number(d.value)}`;
      } else if (d.kind === 'item') {
        const pk = await this.visibleKey(user, q.parentId);
        if (!pk) return { items: [], total: 0 };
        const t = (await this.q<{ type: string }>('select type from plex_items where rating_key = $1', [pk]))[0]?.type;
        parentCond = t === 'collection'
          ? `i.rating_key in (select item_key from plex_collection_items where collection_key = ${pk})`
          : t === 'show' ? `(i.grandparent_key = ${pk} or i.parent_key = ${pk})`
          : `i.parent_key = ${pk}`;
      } else return { items: [], total: 0 };
    }
    const types = plexTypes(q.types);
    const limit = Math.min(q.limit ?? 60, 200);
    return this.rows(user, (p) => {
      const w: string[] = [`i.type = any(${p(types)}::text[])`];
      if (parentCond) w.push(parentCond);
      if (q.q) w.push(`(i.title ilike ${p(like(q.q))} or i.original_title ilike ${p(like(q.q))})`);
      if (q.ids) {
        const keys = q.ids.map((x) => plexKey(x)).filter((x): x is string => x !== null);
        w.push(`i.rating_key = any(${p(keys)}::bigint[])`);
      }
      const playedExpr = `(case when i.type in ('show', 'season') then g.ep_total > 0 and g.ep_played >= g.ep_total else coalesce(ud.played, false) end)`;
      if (q.filter === 'favorites') w.push('coalesce(ud.favorite, false)');
      if (q.filter === 'played') w.push(playedExpr);
      if (q.filter === 'unplayed') w.push(`not ${playedExpr}`);
      if (q.genre) {
        const gs = q.genre.split('|').map((g) => g.trim().toLowerCase()).filter(Boolean);
        w.push(`exists (select 1 from plex_tags t where t.rating_key = i.rating_key and t.kind = 'genre' and lower(t.tag) = any(${p(gs)}::text[]))`);
      }
      if (q.studio) {
        const s = p(q.studio.toLowerCase());
        w.push(`(lower(i.studio) = ${s} or exists (select 1 from plex_tags t where t.rating_key = i.rating_key and t.kind = 'studio' and lower(t.tag) = ${s}))`);
      }
      if (q.tag) w.push(`exists (select 1 from plex_tags t where t.rating_key = i.rating_key and t.kind = 'label' and lower(t.tag) = ${p(q.tag.toLowerCase())})`);
      if (q.year) w.push(`i.year = ${p(q.year)}`);
      else if (q.decade) w.push(`i.year between ${p(q.decade)} and ${p(q.decade + 9)}`);
      if (q.minRating) w.push(`coalesce(i.audience_rating, i.critic_rating) >= ${p(q.minRating)}`);
      if (q.person) {
        const tid = plexKey(q.person, 'tag');
        if (!tid) w.push('false');
        else {
          const tp = p(tid);
          w.push(`(exists (select 1 from plex_tags t where t.rating_key = i.rating_key and t.tag_id = ${tp} and t.kind in ('actor', 'director', 'writer', 'producer'))
            or (i.type = 'show' and exists (select 1 from plex_items e join plex_tags t on t.rating_key = e.rating_key
              where e.grandparent_key = i.rating_key and e.type = 'episode' and t.tag_id = ${tp} and t.kind in ('actor', 'director', 'writer', 'producer'))))`);
        }
      }
      const dir = q.desc ? 'desc' : 'asc';
      const keys = (q.sort ?? 'SortName').split(',').map((k) => SORT[k.trim().toLowerCase()]).filter((x): x is string => Boolean(x));
      const order = [...(keys.length ? keys : [SORT.sortname!]).map((e) => `${e} ${dir} nulls last`), `i.rating_key ${dir}`].join(', ');
      return { where: w, order, limit, offset: q.start ?? 0, total: true };
    });
  }

  async item(user: MediaUser, id: string): Promise<ItemDto> {
    const key = `${user.jellyfin_user_id}|${user.id}|${id}`;
    const now = Date.now();
    const hit = this.itemMemo.get(key);
    if (hit && hit.exp > now) {
      this.itemMemo.delete(key);
      this.itemMemo.set(key, hit);
      return cloneItem(await hit.p);
    }
    const p = this.loadItem(user, id);
    const entry = { exp: now + ITEM_MEMO_TTL_MS, p };
    this.itemMemo.set(key, entry);
    while (this.itemMemo.size > ITEM_MEMO_MAX) this.itemMemo.delete(this.itemMemo.keys().next().value!);
    p.catch(() => {
      if (this.itemMemo.get(key) === entry) this.itemMemo.delete(key);
    });
    return cloneItem(await p);
  }

  private async loadItem(user: MediaUser, id: string): Promise<ItemDto> {
    const d = decodePlexId(id);
    if (d?.kind === 'section') {
      const v = (await this.views(user)).find((x) => x.id === id);
      if (v) return v;
    } else if (d?.kind === 'tag') {
      const per = await this.person(user, id);
      if (per) return { id: per.id, name: per.name, type: 'Person', genres: [], image: per.image, backdrop: false, logo: false, trailers: 0, played: false, favorite: false, positionTicks: 0 };
    } else if (d?.kind === 'item') {
      const r = await this.rows(user, (p) => ({ where: [`i.rating_key = ${p(d.value)}`] }));
      if (r.items[0]) return r.items[0];
    }
    throw new PlexError(404, 'Plex: item not found');
  }

  forgetItems(identity?: string): void {
    if (identity === undefined) return this.itemMemo.clear();
    for (const k of [...this.itemMemo.keys()]) if (k.startsWith(`${identity}|`)) this.itemMemo.delete(k);
  }

  async touchUserData(identity: string): Promise<void> {
    this.forgetItems(identity);
    await this.kv.incr(`jfud:${identity}`, 7 * 86400).catch(() => undefined);
  }

  async userDataVersion(user: MediaUser): Promise<string> {
    return (await this.kv.get(`jfud:${user.jellyfin_user_id}`).catch(() => null)) ?? '0';
  }

  private async mutate<T>(user: MediaUser, fn: () => Promise<T>): Promise<T> {
    this.forgetItems(user.jellyfin_user_id);
    try {
      return await fn();
    } finally {
      await this.touchUserData(user.jellyfin_user_id);
    }
  }

  async resume(user: MediaUser): Promise<ItemDto[]> {
    return (await this.rows(user, () => ({
      where: [`i.type in ('movie', 'episode')`, 'coalesce(ud.position_ticks, 0) > 0', 'not coalesce(ud.played, false)'],
      order: 'ud.last_played desc nulls last, i.rating_key desc', limit: 40,
    }))).items;
  }

  async history(user: MediaUser, q: { start?: number; limit?: number } = {}): Promise<ItemDto[]> {
    return (await this.rows(user, () => ({
      where: [`i.type in ('movie', 'episode')`, 'ud.last_played is not null', '(ud.played or ud.position_ticks > 0)'],
      order: 'ud.last_played desc, i.rating_key desc', limit: Math.min(q.limit ?? 50, 200), offset: q.start ?? 0,
    }))).items;
  }

  async nextUp(user: MediaUser, seriesId?: string): Promise<ItemDto[]> {
    const acc = await this.access(user);
    let show: string | null = null;
    if (seriesId) {
      show = await this.visibleKey(user, seriesId, ['show']);
      if (!show) return [];
    }
    const { params, p } = paramList();
    const idp = p(acc.identity);
    const r = await this.q<{ next: string | null }>(
      `with last as (
         select distinct on (e.grandparent_key) e.grandparent_key show, coalesce(e.parent_idx, 0) s, coalesce(e.idx, 0) n, u.last_played
         from plex_userdata u join plex_items e on e.rating_key = u.rating_key
         where u.identity_id = ${idp} and u.played and e.type = 'episode' and e.grandparent_key is not null ${show ? `and e.grandparent_key = ${p(show)}` : ''}
           and ${visibleSql(acc, 'e', p)}
         order by e.grandparent_key, u.last_played desc nulls last, e.parent_idx desc, e.idx desc
       )
       select (select x.rating_key from plex_items x left join plex_userdata xu on xu.identity_id = ${idp} and xu.rating_key = x.rating_key
               where x.type = 'episode' and x.grandparent_key = l.show and coalesce(x.parent_idx, 0) > 0
                 and (coalesce(x.parent_idx, 0), coalesce(x.idx, 0)) > (l.s, l.n) and not coalesce(xu.played, false) and ${visibleSql(acc, 'x', p)}
               order by x.parent_idx, x.idx limit 1) next
       from last l order by l.last_played desc nulls last limit 20`,
      params,
    );
    const keys = r.map((x) => x.next).filter((x): x is string => x !== null).map(String);
    if (!keys.length) return [];
    const got = await this.rows(user, (pp) => ({ where: [`i.rating_key = any(${pp(keys)}::bigint[])`] }));
    const byId = new Map(got.items.map((i) => [i.id, i]));
    return keys.map((k) => byId.get(encodePlexId('item', k))).filter((x): x is ItemDto => Boolean(x));
  }

  async nextEpisode(user: MediaUser, seriesId: string, episodeId: string): Promise<ItemDto | null> {
    const show = await this.mustSee(user, seriesId, ['show']);
    const ep = plexKey(episodeId);
    if (!ep) return null;
    const cur = (await this.q<{ s: number; n: number }>(
      `select coalesce(parent_idx, 0) s, coalesce(idx, 0) n from plex_items where rating_key = $1 and type = 'episode' and grandparent_key = $2`, [ep, show]))[0];
    if (!cur) return null;
    const r = await this.rows(user, (p) => ({
      where: [`i.type = 'episode'`, `i.grandparent_key = ${p(show)}`, `(coalesce(i.parent_idx, 0), coalesce(i.idx, 0), i.rating_key) > (${p(cur.s)}::int, ${p(cur.n)}::int, ${p(ep)}::bigint)`],
      order: 'coalesce(i.parent_idx, 0), coalesce(i.idx, 0), i.rating_key', limit: 1,
    }));
    return r.items[0] ?? null;
  }

  async seasons(user: MediaUser, seriesId: string): Promise<ItemDto[]> {
    const show = await this.mustSee(user, seriesId, ['show']);
    return (await this.rows(user, (p) => ({ where: [`i.type = 'season'`, `i.parent_key = ${p(show)}`], order: 'coalesce(i.idx, 0), i.rating_key' }))).items;
  }

  async episodes(user: MediaUser, seriesId: string, seasonId?: string): Promise<ItemDto[]> {
    const show = await this.mustSee(user, seriesId, ['show']);
    const season = seasonId ? plexKey(seasonId) : null;
    if (seasonId && !season) return [];
    return (await this.rows(user, (p) => ({
      where: [`i.type = 'episode'`, `i.grandparent_key = ${p(show)}`, ...(season ? [`i.parent_key = ${p(season)}`] : [])],
      order: 'coalesce(i.parent_idx, 0), coalesce(i.idx, 0), i.rating_key',
    }))).items;
  }

  async firstEpisode(user: MediaUser, seriesId: string): Promise<{ id: string; runtimeTicks?: number } | null> {
    const show = await this.visibleKey(user, seriesId, ['show']);
    if (!show) return null;
    const r = await this.rows(user, (p) => ({
      where: [`i.type = 'episode'`, `i.grandparent_key = ${p(show)}`],
      order: 'case when coalesce(i.parent_idx, 0) = 0 then 1 else 0 end, coalesce(i.parent_idx, 0), coalesce(i.idx, 0), i.rating_key', limit: 1,
    }));
    const e = r.items[0];
    return e ? { id: e.id, ...(e.runtimeTicks !== undefined ? { runtimeTicks: e.runtimeTicks } : {}) } : null;
  }

  /** Plex knows no announced episodes. */
  async upcoming(): Promise<ItemDto[]> {
    return [];
  }

  /** Same-type titles sharing genres / cast with the item (series for an episode), access-filtered; Plex's own "similar" needs online data. */
  async similar(user: MediaUser, id: string, limit = 24): Promise<ItemDto[]> {
    let base = await this.mustSee(user, id);
    const row = (await this.q<{ type: string; grandparent_key: string | null; parent_key: string | null }>('select type, grandparent_key, parent_key from plex_items where rating_key = $1', [base]))[0]!;
    if (row.type === 'episode' && row.grandparent_key) base = String(row.grandparent_key);
    else if (row.type === 'season' && row.parent_key) base = String(row.parent_key);
    const type = row.type === 'movie' ? 'movie' : 'show';
    return (await this.rows(user, (p) => {
      const b = p(base);
      const score = `((select count(*) from plex_tags a join plex_tags c on c.kind = a.kind and lower(c.tag) = lower(a.tag)
          where a.rating_key = ${b} and c.rating_key = i.rating_key and a.kind = 'genre') * 2
        + (select count(*) from plex_tags a join plex_tags c on c.kind = a.kind and c.tag = a.tag
          where a.rating_key = ${b} and c.rating_key = i.rating_key and a.kind in ('actor', 'director')))`;
      return {
        where: [`i.type = ${p(type)}`, `i.rating_key <> ${b}`, `${score} > 0`],
        order: `${score} desc, coalesce(i.audience_rating, i.critic_rating) desc nulls last, i.rating_key`, limit: Math.min(Math.max(limit, 1), 100),
      };
    })).items;
  }

  async lastWatched(user: MediaUser): Promise<ItemDto | null> {
    const r = await this.rows(user, () => ({ where: [`i.type in ('movie', 'episode')`, 'ud.played'], order: 'ud.last_played desc nulls last', limit: 1 }));
    const i = r.items[0];
    if (!i) return null;
    return i.type === 'Episode' && i.seriesId ? this.item(user, i.seriesId).catch(() => null) : i;
  }

  async unplayedIds(user: MediaUser, types: string, cap = 5000): Promise<Set<string>> {
    const acc = await this.access(user);
    const { params, p } = paramList();
    const idp = p(acc.identity);
    const r = await this.q<{ rating_key: string }>(
      `select i.rating_key from plex_items i left join plex_userdata ud on ud.identity_id = ${idp} and ud.rating_key = i.rating_key
       where i.type = any(${p(plexTypes(types))}::text[]) and ${visibleSql(acc, 'i', p)}
         and case when i.type = 'show' then exists (select 1 from plex_items e left join plex_userdata u on u.identity_id = ${idp} and u.rating_key = e.rating_key
             where e.type = 'episode' and e.grandparent_key = i.rating_key and not coalesce(u.played, false) and ${visibleSql(acc, 'e', p)})
           else not coalesce(ud.played, false) end
       order by i.rating_key limit ${Math.max(0, Math.floor(cap))}`, params);
    return new Set(r.map((x) => encodePlexId('item', x.rating_key)));
  }

  async collections(user: MediaUser): Promise<ItemDto[]> {
    return (await this.rows(user, () => ({ where: [`i.type = 'collection'`], order: 'lower(coalesce(i.title_sort, i.title)), i.rating_key', limit: 100 }))).items;
  }

  private async tagCounts(user: MediaUser, kind: 'genre' | 'studio', types: string[], limit: number): Promise<Array<{ name: string; count: number }>> {
    const acc = await this.access(user);
    const { params, p } = paramList();
    const studio = kind === 'studio';
    const r = await this.q<{ name: string; n: string }>(
      `select min(x.name) name, count(distinct x.rating_key) n from (
         select t.tag name, i.rating_key from plex_tags t join plex_items i on i.rating_key = t.rating_key
         where t.kind = ${p(kind)} and i.type = any(${p(types)}::text[]) and ${visibleSql(acc, 'i', p)}
         ${studio ? `union all select i.studio, i.rating_key from plex_items i where i.studio is not null and i.type = any(${p(types)}::text[]) and ${visibleSql(acc, 'i', p)}` : ''}
       ) x group by lower(x.name) order by lower(min(x.name)) limit ${limit}`, params);
    return r.map((x) => ({ name: x.name, count: Number(x.n) }));
  }

  async genres(user: MediaUser, types = 'Movie,Series'): Promise<string[]> {
    return (await this.tagCounts(user, 'genre', plexTypes(types), 500)).map((g) => g.name);
  }

  async studios(user: MediaUser): Promise<string[]> {
    return (await this.tagCounts(user, 'studio', ['movie', 'show'], 80)).map((s) => s.name);
  }

  async facets(user: MediaUser, kind: 'studio' | 'genre'): Promise<Array<{ name: string; count: number }>> {
    return this.tagCounts(user, kind, ['movie', 'show'], 200).catch(() => []);
  }

  private async clips(user: MediaUser, id: string, trailers: boolean): Promise<ItemDto[]> {
    const owner = await this.visibleKey(user, id);
    if (!owner) return [];
    return (await this.rows(user, (p) => ({
      where: [`i.type = 'clip'`, `i.parent_key = ${p(owner)}`, trailers ? `i.extra_type = 'trailer'` : `coalesce(i.extra_type, '') <> 'trailer'`],
      order: 'coalesce(i.idx, 0), i.rating_key',
    }))).items;
  }

  extras(user: MediaUser, id: string): Promise<ItemDto[]> {
    return this.clips(user, id, false);
  }

  trailers(user: MediaUser, id: string): Promise<ItemDto[]> {
    return this.clips(user, id, true);
  }

  async trailer(user: MediaUser, id: string): Promise<string | null> {
    return (await this.trailers(user, id))[0]?.id ?? null;
  }

  // person images: image is always false - the gateway serves item images only (Plex person thumbs are often external URLs)
  async people(user: MediaUser, id: string): Promise<Array<{ id: string; name: string; role?: string; type: string; image: boolean }>> {
    const rk = await this.mustSee(user, id);
    const r = await this.q<{ tag: string; tag_id: string; role: string | null; kind: string; thumb: string | null; own: boolean }>(
      `select t.tag, t.tag_id, t.role, t.kind, t.thumb, t.rating_key = $1 own from plex_tags t
       where t.kind = any($2::text[]) and t.tag_id is not null
         and t.rating_key in (select $1::bigint union select grandparent_key from plex_items where rating_key = $1 and type = 'episode'
           union select parent_key from plex_items where rating_key = $1 and type = 'season')
       order by array_position($2::text[], t.kind), t.pos`,
      [rk, PEOPLE_KINDS],
    );
    const own = r.some((x) => x.own) ? r.filter((x) => x.own) : r;
    const seen = new Set<string>();
    return own.filter((x) => !seen.has(`${x.tag_id}|${x.kind}`) && seen.add(`${x.tag_id}|${x.kind}`)).slice(0, 40)
      .map((x) => ({ id: encodePlexId('tag', x.tag_id), name: x.tag, ...(x.role ? { role: x.role } : {}), type: PERSON_TYPE[x.kind] ?? 'Actor', image: false }));
  }

  async searchPeople(user: MediaUser, q: string, limit = 12): Promise<Array<{ id: string; name: string; image: boolean }>> {
    const acc = await this.access(user);
    const { params, p } = paramList();
    const r = await this.q<{ tag_id: string; tag: string; thumb: string | null }>(
      `select t.tag_id, min(t.tag) tag, max(t.thumb) thumb from plex_tags t join plex_items i on i.rating_key = t.rating_key
       where t.kind = any(${p(PEOPLE_KINDS)}::text[]) and t.tag_id is not null and t.tag ilike ${p(like(q))} and ${visibleSql(acc, 'i', p)}
       group by t.tag_id order by count(*) desc, min(t.tag) limit ${Math.min(Math.max(limit, 1), 100)}`, params);
    return r.map((x) => ({ id: encodePlexId('tag', x.tag_id), name: x.tag, image: false }));
  }

  /** A person exists for the viewer only when at least one title it appears in is visible. */
  async person(user: MediaUser, id: string): Promise<PersonDto | null> {
    const tid = plexKey(id, 'tag');
    if (!tid) return null;
    const acc = await this.access(user);
    const { params, p } = paramList();
    const r = await this.q<{ tag: string; thumb: string | null }>(
      `select t.tag, t.thumb from plex_tags t join plex_items i on i.rating_key = t.rating_key
       where t.tag_id = ${p(tid)} and t.kind = any(${p(PEOPLE_KINDS)}::text[]) and ${visibleSql(acc, 'i', p)} order by t.thumb nulls last limit 1`, params);
    return r[0] ? { id: encodePlexId('tag', tid), name: r[0].tag, image: false } : null;
  }

  async tracks(user: MediaUser, id: string): Promise<TrackList> {
    const m = await this.mediaOf(user, id);
    const streams: Array<Record<string, any>> = m.media[0]?.Part?.[0]?.Stream ?? [];
    const lang = (s: Record<string, any>) => String(s.languageCode ?? 'und');
    const seenA = new Set<string>();
    const audio = streams.filter((s) => Number(s.streamType) === 2)
      .map((s) => ({ language: lang(s), title: String(s.displayTitle ?? s.title ?? s.language ?? 'Spur'), isDefault: Boolean(s.default) }))
      .filter((a) => !seenA.has(a.language) && seenA.add(a.language));
    const seenS = new Set<string>();
    const subtitles = streams.filter((s) => Number(s.streamType) === 3)
      .map((s) => ({ language: lang(s), title: String(s.displayTitle ?? s.title ?? s.language ?? 'Untertitel') }))
      .filter((a) => !seenS.has(a.language) && seenS.add(a.language));
    const typeOut = { movie: 'Movie', episode: 'Episode', show: 'Series', season: 'Season', clip: 'Video', collection: 'BoxSet' } as Record<string, string>;
    return { audio, subtitles, ...(m.durationMs !== null ? { runtimeTicks: m.durationMs * 10_000 } : {}), type: typeOut[m.type] ?? '' };
  }

  /** Plex markers (intro / credits) when PMS delivered any (Plex Pass analysis); otherwise none. Seconds, like Jellyfin's segments. */
  async segments(user: MediaUser, id: string): Promise<Segment[]> {
    const rk = await this.visibleKey(user, id);
    if (!rk) return [];
    const r = await this.q<{ markers: Array<{ type: string; start: number; end: number }> | null }>('select markers from plex_items where rating_key = $1', [rk]);
    const map: Record<string, string> = { intro: 'intro', credits: 'outro' };
    return (r[0]?.markers ?? []).filter((m) => map[m.type] && m.end > m.start).map((m) => ({ type: map[m.type]!, start: m.start / 1000, end: m.end / 1000 }));
  }

  async addedItems(user: MediaUser, page: { start: number; limit: number }): Promise<ItemDto[]> {
    return (await this.rows(user, () => ({
      where: [`i.type in ('movie', 'episode')`], order: 'i.added_at desc nulls last, i.rating_key desc', limit: Math.min(page.limit, 500), offset: page.start,
    }))).items;
  }

  /** Genres / labels / countries of a visible series (like the Jellyfin implementation: series only). */
  async itemTraits(user: MediaUser, id: string): Promise<ItemTraits | null> {
    const rk = await this.visibleKey(user, id, ['show']);
    if (!rk) return null;
    return this.traitsOf(rk);
  }

  private async traitsOf(rk: string): Promise<ItemTraits> {
    const r = await this.q<{ kind: string; tag: string }>(`select kind, tag from plex_tags where rating_key = $1 and kind in ('genre', 'label', 'country') order by pos`, [rk]);
    return { genres: r.filter((x) => x.kind === 'genre').map((x) => x.tag), tags: r.filter((x) => x.kind === 'label').map((x) => x.tag), countries: r.filter((x) => x.kind === 'country').map((x) => x.tag) };
  }

  /**
   * Best effort: Plex has no "continuing" status. A series counts as continuing while one of its episodes premiered in the last
   * 60 days.
   */
  async continuingSeries(user: MediaUser): Promise<Array<{ item: ItemDto; traits: ItemTraits }>> {
    const r = await this.rows(user, (p) => ({
      where: [`i.type = 'show'`, `exists (select 1 from plex_items e where e.type = 'episode' and e.grandparent_key = i.rating_key and e.originally_available >= ${p(new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10))}::date)`],
      order: 'lower(coalesce(i.title_sort, i.title))', limit: 300,
    }));
    const out: Array<{ item: ItemDto; traits: ItemTraits }> = [];
    for (const item of r.items) out.push({ item, traits: await this.traitsOf(plexKey(item.id)!) });
    return out;
  }

  /** Episodes with an air date in [from, to] (dates only: Plex has no air time), newest first. Plex has no announced episodes. */
  async premieringEpisodes(user: MediaUser, from: string, to: string): Promise<ItemDto[]> {
    return (await this.rows(user, (p) => ({
      where: [`i.type = 'episode'`, `i.originally_available between ${p(from.slice(0, 10))}::date and ${p(to.slice(0, 10))}::date`],
      order: 'i.originally_available desc, i.rating_key desc', limit: 600,
    }))).items;
  }

  /** Every mirrored episode is real (Plex lists no placeholders): the visible subset of `ids`. */
  async availableEpisodes(user: MediaUser, ids: string[]): Promise<Set<string>> {
    const keys = ids.map((x) => plexKey(x)).filter((x): x is string => x !== null);
    if (!keys.length) return new Set();
    const acc = await this.access(user);
    const { params, p } = paramList();
    const r = await this.q<{ rating_key: string }>(`select i.rating_key from plex_items i where i.type = 'episode' and i.rating_key = any(${p(keys)}::bigint[]) and ${visibleSql(acc, 'i', p)}`, params);
    return new Set(r.map((x) => encodePlexId('item', x.rating_key)));
  }

  async seasonEpisodeIds(user: MediaUser, seriesId: string, season: number): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const show = await this.visibleKey(user, seriesId, ['show']);
    if (!show) return out;
    const acc = await this.access(user);
    const { params, p } = paramList();
    const r = await this.q<{ rating_key: string; idx: number | null }>(
      `select i.rating_key, i.idx from plex_items i where i.type = 'episode' and i.grandparent_key = ${p(show)} and i.parent_idx = ${p(season)} and ${visibleSql(acc, 'i', p)} order by i.idx, i.rating_key`, params);
    for (const x of r) if (x.idx !== null && !out.has(x.idx)) out.set(x.idx, encodePlexId('item', x.rating_key));
    return out;
  }

  // ---------------------------------------------------------------- Block 17: traits, chapters, credits (mirror only)

  /** Best video / audio of a visible title from the mirrored streams; a series reports its best episode the viewer may see. */
  async mediaTraits(user: MediaUser, id: string): Promise<MediaTraits | null> {
    const rk = await this.visibleKey(user, id, ['movie', 'episode', 'show']);
    if (!rk) return null;
    const acc = await this.access(user);
    const { params, p } = paramList();
    const r = await this.q<{ media: Array<Record<string, any>> | null }>(
      `select i.media from plex_items i where (i.rating_key = ${p(rk)} and i.type <> 'show')
         or (i.type = 'episode' and i.grandparent_key = ${p(rk)} and i.media is not null and ${visibleSql(acc, 'i', p)})
       order by i.rating_key limit 1000`, params);
    return plexTraits(r.flatMap((x) => x.media ?? []));
  }

  /** One page of the whole library's traits (stable order by rating key; items without streams count as SD so a short page = end). */
  async libraryMediaTraits(type: 'Movie' | 'Episode', start: number, limit: number): Promise<ItemMediaTraits[]> {
    const r = await this.q<{ rating_key: string; grandparent_key: string | null; media: Array<Record<string, any>> | null }>(
      `select rating_key, grandparent_key, media from plex_items where type = $1 order by rating_key offset $2 limit $3`,
      [type === 'Episode' ? 'episode' : 'movie', Math.max(0, start), Math.max(0, limit)]);
    return r.map((x) => ({
      id: encodePlexId('item', x.rating_key), ...(x.grandparent_key ? { seriesId: encodePlexId('item', x.grandparent_key) } : {}),
      traits: plexTraits(x.media) ?? { resolution: 'sd', hdr: null, audio: null },
    }));
  }

  /**
   * One page of the ids of every series that may still continue (library-wide). Plex has no series status, so this is conservative:
   * a series counts as ended only when it has episodes, all with an air date, the newest older than CONTINUING_DAYS - everything
   * else is "continuing" (fresh.ts then never calls its newest episode a season finale by mistake).
   */
  async libraryContinuingSeriesIds(start: number, limit: number): Promise<string[]> {
    const r = await this.q<{ rating_key: string }>(
      `select s.rating_key from plex_items s where s.type = 'show' and not exists (
         select 1 from plex_items e where e.type = 'episode' and e.grandparent_key = s.rating_key
         having count(*) > 0 and count(*) = count(e.originally_available) and max(e.originally_available) < $1::date)
       order by s.rating_key offset $2 limit $3`,
      [new Date(Date.now() - CONTINUING_DAYS * 86_400_000).toISOString().slice(0, 10), Math.max(0, start), Math.max(0, limit)]);
    return r.map((x) => encodePlexId('item', x.rating_key));
  }

  /** Chapter marks of a visible video (includeChapters=1 in the detail sync), stills when PMS generated chapter thumbnails; 404 otherwise. */
  async chapters(user: MediaUser, id: string): Promise<ChapterDto[]> {
    const rk = await this.mustSee(user, id);
    const r = await this.q<{ chapters: MirrorChapter[] | null }>('select chapters from plex_items where rating_key = $1', [rk]);
    return chapterDtos(id, r[0]?.chapters, this.secret);
  }

  /**
   * Credits of one visible item from the mirrored tags: Role (character name in `role`), Director, Writer, Producer; studios; labels as
   * tags. Episodes report only their own (the castinfo route takes the regulars from the series and calls the rest guest stars).
   */
  async credits(user: MediaUser, id: string): Promise<ItemCreditsDto> {
    const rk = await this.mustSee(user, id);
    const r = await this.q<{ tag: string; tag_id: string | null; role: string | null; kind: string }>(
      `select tag, tag_id, role, kind from plex_tags where rating_key = $1 and kind = any($2::text[]) order by array_position($2::text[], kind), pos`,
      [rk, [...PEOPLE_KINDS, 'studio', 'label']]);
    const seen = new Set<string>();
    const people = r.filter((x) => PEOPLE_KINDS.includes(x.kind) && x.tag_id !== null && !seen.has(`${x.tag_id}|${x.kind}`) && seen.add(`${x.tag_id}|${x.kind}`))
      .slice(0, 80)
      .map((x) => ({ id: encodePlexId('tag', x.tag_id!), name: x.tag, ...(x.role ? { role: x.role } : {}), type: PERSON_TYPE[x.kind] ?? 'Actor', image: false }));
    const names = (kind: string, max: number) => [...new Set(r.filter((x) => x.kind === kind).map((x) => x.tag))].slice(0, max);
    return { people, studios: names('studio', 6), tags: names('label', 20) };
  }

  // ---------------------------------------------------------------- user data

  async setFavorite(user: MediaUser, id: string, on: boolean): Promise<void> {
    const rk = await this.mustSee(user, id);
    await this.mutate(user, () => ud.setFavorite(this.db, user.jellyfin_user_id, rk, on));
  }

  async setPlayed(user: MediaUser, id: string, on: boolean): Promise<void> {
    const rk = await this.mustSee(user, id);
    await this.mutate(user, () => ud.setPlayed(this.db, user.jellyfin_user_id, rk, on));
  }

  async setUserData(user: MediaUser, id: string, d: { positionTicks: number; played: boolean; lastPlayedDate: Date | string }): Promise<void> {
    const rk = await this.mustSee(user, id);
    await this.mutate(user, () => ud.setUserData(this.db, user.jellyfin_user_id, rk, d));
  }

  /** Player progress -> FriendFlix user data only (never Plex timeline/scrobble: that would write into the admin account). */
  async report(user: MediaUser, r: PlaybackReport): Promise<void> {
    if (this.playback.report) return this.playback.report(user, r);
    return this.recordReport(user, r);
  }

  /** The user-data part of report() (the playback delegate's report() calls it too). */
  async recordReport(user: MediaUser, r: PlaybackReport): Promise<void> {
    const rk = await this.mustSee(user, r.itemId);
    const dur = (await this.q<{ duration_ms: string | null }>('select duration_ms from plex_items where rating_key = $1', [rk]))[0]?.duration_ms;
    await this.mutate(user, () => ud.recordProgress(this.db, user.jellyfin_user_id, rk, {
      event: r.event, positionTicks: r.positionTicks, ...(dur ? { runtimeTicks: Number(dur) * 10_000 } : {}),
    }));
  }

  // ---------------------------------------------------------------- lifecycle

  async start(rt: MediaRuntime): Promise<void> {
    await this.ready();
    await refreshAges(this.db, rt.log, true);
    await this.refreshFlags();
    this.sync.start(rt, { websocket: this.websocket });
    this.flagTimer = setInterval(() => void this.refreshFlags().catch(() => undefined), 5 * 60_000);
  }

  async stop(): Promise<void> {
    if (this.flagTimer) clearInterval(this.flagTimer);
    this.flagTimer = null;
    await this.sync.stop();
  }

  /** Learns the capability flags from the mirror (markers present, BIF index files present). */
  async refreshFlags(): Promise<void> {
    const r = await this.q<{ markers: boolean; bif: boolean; chapters: boolean }>(
      `select exists (select 1 from plex_items where markers is not null and jsonb_array_length(markers) > 0) markers,
              exists (select 1 from plex_items where media::text like '%"indexes": "sd"%' or media::text like '%"indexes":"sd"%') bif,
              exists (select 1 from plex_items where chapters is not null and jsonb_array_length(chapters) > 0) chapters`);
    this.flags = { markers: Boolean(r[0]?.markers), bif: Boolean(r[0]?.bif), chapters: Boolean(r[0]?.chapters) };
  }

  // ---------------------------------------------------------------- admin-key lookups

  async searchSubtitles(): Promise<SubtitleHit[]> {
    return [];
  }

  async downloadSubtitle(): Promise<void> {
    throw new PlexError(501, 'Plex: remote subtitle search is not supported');
  }

  async findByTmdb(tmdbId: number, mediaType: string): Promise<{ id: string; name: string } | null> {
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
    const r = await this.q<{ rating_key: string; title: string }>(
      `select rating_key, title from plex_items where type = $1 and guids @> array[$2]::text[] order by rating_key limit 1`,
      [mediaType === 'tv' ? 'show' : 'movie', `tmdb://${tmdbId}`]);
    return r[0] ? { id: encodePlexId('item', r[0].rating_key), name: r[0].title } : null;
  }

  async seriesHasEpisode(seriesId: string): Promise<boolean> {
    const rk = plexKey(seriesId);
    if (!rk) return false;
    return (await this.q(`select 1 from plex_items where type = 'episode' and grandparent_key = $1 limit 1`, [rk])).length > 0;
  }

  async libraryStreams(type: 'Movie' | 'Episode', start: number, limit: number): Promise<ItemStreams[]> {
    const r = await this.q<{ rating_key: string; grandparent_key: string | null; media: Array<Record<string, any>> | null }>(
      `select rating_key, grandparent_key, media from plex_items where type = $1 order by rating_key offset $2 limit $3`,
      [type === 'Episode' ? 'episode' : 'movie', Math.max(0, start), Math.max(0, limit)]);
    return r.map((x) => {
      const streams: Array<Record<string, any>> = x.media?.[0]?.Part?.[0]?.Stream ?? [];
      const langs = (t: number) => streams.filter((s) => Number(s.streamType) === t && s.languageCode != null).map((s) => String(s.languageCode));
      return {
        id: encodePlexId('item', x.rating_key), ...(x.grandparent_key ? { seriesId: encodePlexId('item', x.grandparent_key) } : {}),
        audio: langs(2), subtitles: langs(3),
      };
    });
  }

  // ---------------------------------------------------------------- admin

  private makeAdmin(): MediaAdmin {
    return {
      /** A synthetic identity: Plex gets no account (no plex.tv users needed); the password is not used. */
      createIdentity: async (name) => {
        const id = randomBytes(16).toString('hex');
        await this.q('insert into plex_identities(id, name) values ($1, $2)', [id, String(name).slice(0, 200)]);
        return { id };
      },
      deleteIdentity: async (id) => {
        await this.q('delete from plex_identities where id = $1', [id]);
        await ud.forgetIdentity(this.db, id);
        this.dropAccess(id);
      },
      applyPolicy: async (id, p: IdentityPolicy) => {
        const t = p.template;
        const maxAge = p.parental?.maxRating !== undefined ? p.parental.maxRating : t.maxParentalRating;
        await this.q('insert into plex_identities(id, name) values ($1, $1) on conflict (id) do nothing', [id]);
        await this.q(
          `insert into plex_media_policies(identity_id, libraries, max_age, block_unrated, disabled, hidden, max_bitrate, max_streams, transcoding, max_height, download, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
           on conflict (identity_id) do update set libraries = excluded.libraries, max_age = excluded.max_age, block_unrated = excluded.block_unrated,
             disabled = excluded.disabled, hidden = excluded.hidden, max_bitrate = excluded.max_bitrate, max_streams = excluded.max_streams,
             transcoding = excluded.transcoding, max_height = excluded.max_height, download = excluded.download, updated_at = now()`,
          [id, t.libraries === 'all' ? null : t.libraries, maxAge, p.parental?.blockUnrated ?? [], p.disabled, Boolean(p.hidden), t.maxBitrate, t.maxStreams,
            t.transcoding, t.maxHeight, t.download],
        );
        this.dropAccess(id);
      },
      /** Disabling an identity without a policy row creates a closed one (no libraries). */
      setDisabled: async (id, disabled) => {
        await this.q('insert into plex_identities(id, name) values ($1, $1) on conflict (id) do nothing', [id]);
        await this.q(
          `insert into plex_media_policies(identity_id, libraries, disabled) values ($1, '{}', $2)
           on conflict (identity_id) do update set disabled = excluded.disabled, updated_at = now()`, [id, disabled]);
        this.dropAccess(id);
      },
      libraries: async () => {
        try {
          const secs = await this.client.sections();
          return secs.filter((s) => s.type === 'movie' || s.type === 'show').map((s) => ({ id: encodePlexId('section', String(s.key)), name: String(s.title ?? '') }));
        } catch {
          return (await this.sections()).map((s) => ({ id: encodePlexId('section', s.id), name: s.title }));
        }
      },
      ping: () => this.client.ping(),
      /** Playback by other Plex apps runs under the admin account: not attributable to a FriendFlix user. */
      externalSessions: async (): Promise<ExternalSession[]> => [],
    };
  }
}
