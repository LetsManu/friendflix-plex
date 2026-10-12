import { decrypt, encrypt } from '../crypto.js';
import type { KV } from '../kv.js';
import type { JfUser } from '../types.js';
import { JellyfinClient, JellyfinError } from './client.js';
import { maxWidthFor, toDownloadSource, toItemDto, toPlaybackDto, type DownloadQuality, type DownloadSourceDto, type ItemDto, type PlaybackDto } from './dto.js';

const TOKEN_TTL = 6 * 3600;
/** item() memo: one detail page fires ~8 parallel requests that each load the same item (access check / data). */
export const ITEM_MEMO_TTL_MS = 10_000;
export const ITEM_MEMO_MAX = 2000;
const normId = (s: string) => s.replace(/-/g, '').toLowerCase();
const cloneItem = (i: ItemDto): ItemDto => ({ ...i, genres: [...i.genres], ...(i.imageTags ? { imageTags: { ...i.imageTags } } : {}) });
const FIELDS = 'Overview,Genres,OfficialRating,CommunityRating,PremiereDate,DateCreated,ProductionYear,ChildCount,RunTimeTicks,DateLastMediaAdded';

export interface ItemQuery {
  parentId?: string;
  q?: string;
  types?: string;
  sort?: string;
  desc?: boolean;
  limit?: number;
  start?: number;
  filter?: 'favorites' | 'unplayed' | 'played';
  ids?: string[];
  genre?: string;
  studio?: string;
  decade?: number;
  year?: number;
  minRating?: number;
  person?: string;
}

/**
 * Per-user Jellyfin access. The portal logs in server-side (AuthenticateByName) with the
 * stored (encrypted) password, caches the user token (encrypted, in Redis) and re-authenticates
 * on 401. The token never leaves the backend/gateway.
 */
export class JellyfinService {
  /** Remembers which of two possible API paths a given Jellyfin version supports. */
  private readonly compatChoice = new Map<string, number>();
  /**
   * Short-lived item() memo, keyed by portal user/profile id + Jellyfin user id + item id (UserData and visibility are per Jellyfin
   * user, so one user can never get another user's entry). Holds the promise, so concurrent callers share one Jellyfin call;
   * failures are dropped at once. Insertion order = LRU order (hits are re-inserted). Any write through this service
   * (played, favorite, user data, playback reports) drops every entry of that Jellyfin user: Jellyfin cascades played state
   * to episodes and series counts, so a per-item drop would not be enough.
   */
  private readonly itemMemo = new Map<string, { exp: number; p: Promise<ItemDto> }>();

  constructor(
    readonly client: JellyfinClient,
    private readonly kv: KV,
    private readonly encKey: Buffer,
  ) {}

  deviceId(user: JfUser) {
    return `ff-${user.id}`;
  }

  async token(user: JfUser, force = false): Promise<string> {
    const key = `jft:${user.id}`;
    if (!force) {
      const cached = await this.kv.get(key);
      if (cached) return decrypt(this.encKey, cached);
    }
    const pw = decrypt(this.encKey, user.jellyfin_pw_enc);
    const auth = await this.client.authenticateByName(user.jellyfin_username, pw, this.deviceId(user));
    await this.kv.set(key, encrypt(this.encKey, auth.AccessToken), TOKEN_TTL);
    return auth.AccessToken;
  }

  async call(user: JfUser, path: string, init: RequestInit = {}): Promise<Response> {
    let res = await this.client.userFetch(await this.token(user), this.deviceId(user), path, init);
    if (res.status === 401) {
      res = await this.client.userFetch(await this.token(user, true), this.deviceId(user), path, init);
    }
    return res;
  }

  async json<T = any>(user: JfUser, path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.call(user, path, init);
    if (!res.ok) throw new JellyfinError(res.status, `Jellyfin ${init.method ?? 'GET'} ${path.split('?')[0]} -> ${res.status}`);
    const t = await res.text();
    return (t ? JSON.parse(t) : undefined) as T;
  }

  /** Tries the current API path first, falls back to the legacy one (paths differ between Jellyfin versions). */
  private async compat<T>(user: JfUser, name: string, paths: string[], init: RequestInit = {}): Promise<T> {
    const start = this.compatChoice.get(name) ?? 0;
    for (let n = 0; n < paths.length; n++) {
      const idx = (start + n) % paths.length;
      const res = await this.call(user, paths[idx]!, init);
      if (res.status === 404 || res.status === 405) continue;
      if (!res.ok) throw new JellyfinError(res.status, `Jellyfin ${name} -> ${res.status}`);
      this.compatChoice.set(name, idx);
      const t = await res.text();
      return (t ? JSON.parse(t) : undefined) as T;
    }
    throw new JellyfinError(404, `Jellyfin ${name}: no supported path`);
  }

  async views(user: JfUser): Promise<ItemDto[]> {
    const uid = user.jellyfin_user_id;
    const r = await this.compat<{ Items: any[] }>(user, 'views', [`/UserViews?userId=${uid}`, `/Users/${uid}/Views`]);
    return r.Items.map(toItemDto);
  }

  async items(user: JfUser, q: ItemQuery): Promise<{ items: ItemDto[]; total: number }> {
    const uid = user.jellyfin_user_id;
    const p = new URLSearchParams({ userId: uid, recursive: 'true', fields: FIELDS, enableTotalRecordCount: 'true' });
    if (q.parentId) p.set('parentId', q.parentId);
    if (q.q) p.set('searchTerm', q.q);
    p.set('includeItemTypes', q.types ?? (q.q ? 'Movie,Series' : 'Movie,Series'));
    p.set('sortBy', q.sort ?? 'SortName');
    p.set('sortOrder', q.desc ? 'Descending' : 'Ascending');
    p.set('limit', String(Math.min(q.limit ?? 60, 200)));
    p.set('startIndex', String(q.start ?? 0));
    if (q.filter === 'favorites') p.set('filters', 'IsFavorite');
    if (q.filter === 'unplayed') p.set('filters', 'IsUnplayed');
    if (q.filter === 'played') p.set('filters', 'IsPlayed');
    if (q.ids?.length) p.set('ids', q.ids.join(','));
    if (q.genre) p.set('genres', q.genre);
    if (q.studio) p.set('studios', q.studio);
    if (q.year) p.set('years', String(q.year)); // year wins over decade
    else if (q.decade) p.set('years', Array.from({ length: 10 }, (_, n) => q.decade! + n).join(','));
    if (q.minRating) p.set('minCommunityRating', String(q.minRating));
    if (q.person) p.set('personIds', q.person);
    const r = await this.json<{ Items: any[]; TotalRecordCount: number }>(user, `/Items?${p}`);
    return { items: r.Items.map(toItemDto), total: r.TotalRecordCount ?? r.Items.length };
  }

  async resume(user: JfUser): Promise<ItemDto[]> {
    const uid = user.jellyfin_user_id;
    const qs = `userId=${uid}&limit=40&mediaTypes=Video&fields=${FIELDS}&enableTotalRecordCount=false`;
    const r = await this.compat<{ Items: any[] }>(user, 'resume', [`/UserItems/Resume?${qs}`, `/Users/${uid}/Items/Resume?${qs}`]);
    return r.Items.map(toItemDto);
  }

  /** Played items (newest first) merged with in-progress ones, as shown in the viewing history. */
  async history(user: JfUser, q: { start?: number; limit?: number } = {}): Promise<ItemDto[]> {
    const p = new URLSearchParams({
      userId: user.jellyfin_user_id, recursive: 'true', includeItemTypes: 'Movie,Episode', sortBy: 'DatePlayed', sortOrder: 'Descending',
      filters: 'IsPlayed', fields: FIELDS, startIndex: String(q.start ?? 0), limit: String(Math.min(q.limit ?? 50, 200)), enableTotalRecordCount: 'false',
    });
    const r = await this.json<{ Items: any[] }>(user, `/Items?${p}`);
    const played = r.Items.map(toItemDto);
    const merged = new Map<string, ItemDto>();
    for (const i of [...(q.start ? [] : await this.resume(user)), ...played]) if (!merged.has(i.id)) merged.set(i.id, i);
    const ts = (i: ItemDto) => (i.lastPlayedDate ? Date.parse(i.lastPlayedDate) || 0 : 0);
    return [...merged.values()].filter((i) => i.lastPlayedDate).sort((a, b) => ts(b) - ts(a)).slice(0, 200);
  }

  async nextUp(user: JfUser, seriesId?: string): Promise<ItemDto[]> {
    const p = new URLSearchParams({ userId: user.jellyfin_user_id, limit: '20', fields: FIELDS });
    if (seriesId) p.set('seriesId', seriesId);
    const r = await this.json<{ Items: any[] }>(user, `/Shows/NextUp?${p}`);
    return r.Items.map(toItemDto);
  }

  /** The episode that follows `episodeId` (same series, across seasons), or null for the last one. */
  async nextEpisode(user: JfUser, seriesId: string, episodeId: string): Promise<ItemDto | null> {
    const p = new URLSearchParams({ userId: user.jellyfin_user_id, startItemId: episodeId, limit: '2', fields: FIELDS });
    const r = await this.json<{ Items: any[] }>(user, `/Shows/${seriesId}/Episodes?${p}`);
    const list = r.Items.map(toItemDto);
    const i = list.findIndex((e) => e.id === episodeId);
    return list[i + 1] ?? null;
  }

  async item(user: JfUser, id: string): Promise<ItemDto> {
    const key = `${normId(user.jellyfin_user_id)}|${user.id}|${normId(id)}`;
    const now = Date.now();
    const hit = this.itemMemo.get(key);
    if (hit && hit.exp > now) {
      this.itemMemo.delete(key); // LRU: move to the end
      this.itemMemo.set(key, hit);
      return cloneItem(await hit.p);
    }
    const uid = user.jellyfin_user_id;
    const p = this.compat<any>(user, 'item', [`/Items/${id}?userId=${uid}`, `/Users/${uid}/Items/${id}`]).then(toItemDto);
    const entry = { exp: now + ITEM_MEMO_TTL_MS, p };
    this.itemMemo.delete(key);
    this.itemMemo.set(key, entry);
    while (this.itemMemo.size > ITEM_MEMO_MAX) this.itemMemo.delete(this.itemMemo.keys().next().value!);
    p.catch(() => {
      if (this.itemMemo.get(key) === entry) this.itemMemo.delete(key); // never cache a failure (404, 5xx, timeout)
    });
    return cloneItem(await p);
  }

  /** Drops the memoised items of one Jellyfin user (after a write, or a webhook about playback elsewhere); no argument: all. */
  forgetItems(jellyfinUserId?: string) {
    if (jellyfinUserId === undefined) return this.itemMemo.clear();
    const prefix = `${normId(jellyfinUserId)}|`;
    for (const k of [...this.itemMemo.keys()]) if (k.startsWith(prefix)) this.itemMemo.delete(k);
  }

  /**
   * The user's played/favorite/progress state changed (a write here, or a Jellyfin webhook): drops the item memo and bumps the
   * shared user-data version that longer caches (e.g. "Weil du ... gesehen hast") put into their keys. Never throws.
   */
  async touchUserData(jellyfinUserId: string): Promise<void> {
    this.forgetItems(jellyfinUserId);
    await this.kv.incr(`jfud:${normId(jellyfinUserId)}`, 7 * 86400).catch(() => undefined);
  }

  /** Current user-data version of a Jellyfin user (see touchUserData); '0' when unknown or Redis fails. */
  async userDataVersion(user: JfUser): Promise<string> {
    return (await this.kv.get(`jfud:${normId(user.jellyfin_user_id)}`).catch(() => null)) ?? '0';
  }

  /** Runs a write for `user` and invalidates its item memo before and after (a read racing the write must not survive it). */
  private async mutate<T>(user: JfUser, fn: () => Promise<T>): Promise<T> {
    this.forgetItems(user.jellyfin_user_id);
    try {
      return await fn();
    } finally {
      await this.touchUserData(user.jellyfin_user_id);
    }
  }

  /** Audio languages and text subtitles of the first media source (for the language picker before playing). */
  async tracks(user: JfUser, id: string): Promise<{ audio: Array<{ language: string; title: string; isDefault: boolean }>; subtitles: Array<{ language: string; title: string }>; runtimeTicks?: number; type: string }> {
    const uid = user.jellyfin_user_id;
    const i = await this.compat<any>(user, 'item', [`/Items/${id}?userId=${uid}`, `/Users/${uid}/Items/${id}`]);
    const streams: Array<Record<string, any>> = (i.MediaSources ?? [])[0]?.MediaStreams ?? i.MediaStreams ?? [];
    const seen = new Set<string>();
    const audio = streams.filter((s) => s.Type === 'Audio').map((s) => ({ language: String(s.Language ?? 'und'), title: String(s.DisplayTitle ?? s.Language ?? 'Spur'), isDefault: Boolean(s.IsDefault) }))
      .filter((a) => !seen.has(a.language) && seen.add(a.language));
    const seenS = new Set<string>();
    const subtitles = streams.filter((s) => s.Type === 'Subtitle').map((s) => ({ language: String(s.Language ?? 'und'), title: String(s.DisplayTitle ?? s.Language ?? 'Untertitel') }))
      .filter((a) => !seenS.has(a.language) && seenS.add(a.language));
    return { audio, subtitles, runtimeTicks: i.RunTimeTicks, type: String(i.Type ?? '') };
  }

  /** Genre names of the viewer's libraries; cached 10 min per Jellyfin user (library visibility is per user). */
  async genres(user: JfUser, types = 'Movie,Series'): Promise<string[]> {
    const key = `genres:${user.jellyfin_user_id}:${types}`;
    const hit = await this.kv.get(key).catch(() => null);
    if (hit) {
      try {
        return JSON.parse(hit) as string[];
      } catch {
        // fall through to a fresh fetch
      }
    }
    const r = await this.json<{ Items: Array<{ Name: string }> }>(user, `/Genres?userId=${user.jellyfin_user_id}&includeItemTypes=${types}&sortBy=SortName`);
    const names = r.Items.map((g) => g.Name);
    await this.kv.set(key, JSON.stringify(names), 600).catch(() => undefined);
    return names;
  }

  /**
   * People search. /Persons is library-global in older Jellyfin versions; passing userId scopes it to the user's libraries
   * in 10.9+ (assumption - the people route additionally requires >= 1 visible title before revealing a person).
   */
  async searchPeople(user: JfUser, q: string, limit = 12): Promise<Array<{ id: string; name: string; image: boolean }>> {
    const p = new URLSearchParams({ userId: user.jellyfin_user_id, searchTerm: q, limit: String(limit) });
    const r = await this.json<{ Items: Array<{ Id: string; Name: string; ImageTags?: { Primary?: string } }> }>(user, `/Persons?${p}`);
    return r.Items.map((i) => ({ id: i.Id, name: i.Name, image: Boolean(i.ImageTags?.Primary) }));
  }

  /** Raw Jellyfin item for a person page (caller checks Type === 'Person'). */
  async person(user: JfUser, id: string): Promise<Record<string, any>> {
    const uid = user.jellyfin_user_id;
    return this.compat<Record<string, any>>(user, 'item', [`/Items/${id}?userId=${uid}`, `/Users/${uid}/Items/${id}`]);
  }

  /**
   * Intro/outro/recap/preview segments (Jellyfin >= 10.10 media segments API). Older servers answer 404 -> empty list,
   * the "Intro überspringen" button then simply never shows.
   */
  async segments(user: JfUser, id: string): Promise<Array<{ type: string; start: number; end: number }>> {
    const res = await this.call(user, `/MediaSegments/${id}`);
    if (!res.ok) return [];
    const r = (await res.json().catch(() => null)) as { Items?: Array<{ Type: string; StartTicks: number; EndTicks: number }> } | null;
    return (r?.Items ?? [])
      .filter((s) => ['Intro', 'Outro', 'Recap', 'Preview'].includes(s.Type) && s.EndTicks > s.StartTicks)
      .map((s) => ({ type: s.Type.toLowerCase(), start: s.StartTicks / 1e7, end: s.EndTicks / 1e7 }));
  }

  /** Resume position + raw trickplay info in ONE lookup (runs in parallel with PlaybackInfo); null when the lookup fails. */
  async playMeta(user: JfUser, itemId: string): Promise<{ positionTicks: number; trickplay?: Record<string, any> } | null> {
    try {
      const r = await this.json<{ Items: Array<{ Trickplay?: Record<string, any>; UserData?: { PlaybackPositionTicks?: number } }> }>(
        user, `/Items?userId=${user.jellyfin_user_id}&ids=${itemId}&fields=Trickplay&enableUserData=true`);
      const it = r.Items[0];
      if (!it) return null;
      return { positionTicks: Number(it.UserData?.PlaybackPositionTicks ?? 0), trickplay: it.Trickplay };
    } catch {
      return null;
    }
  }

  /** "Ähnliche Titel" from Jellyfin's own similarity (genres/people/tags). */
  async similar(user: JfUser, id: string, limit = 24): Promise<ItemDto[]> {
    const r = await this.json<{ Items: any[] }>(user, `/Items/${id}/Similar?userId=${user.jellyfin_user_id}&limit=${limit}&fields=${FIELDS}`);
    return r.Items.map(toItemDto);
  }

  /** Last finished movie/series (episodes are mapped to their series) as seed for "Weil du ... gesehen hast". */
  async lastWatched(user: JfUser): Promise<ItemDto | null> {
    const p = new URLSearchParams({ userId: user.jellyfin_user_id, recursive: 'true', filters: 'IsPlayed', sortBy: 'DatePlayed', sortOrder: 'Descending', limit: '1', includeItemTypes: 'Movie,Episode', fields: FIELDS });
    const r = await this.json<{ Items: any[] }>(user, `/Items?${p}`);
    const i = r.Items[0];
    if (!i) return null;
    return i.Type === 'Episode' && i.SeriesId ? this.item(user, i.SeriesId) : toItemDto(i);
  }

  /** All unwatched ids of a user for the group matcher (paged, capped). */
  async unplayedIds(user: JfUser, types: string, cap = 5000): Promise<Set<string>> {
    const out = new Set<string>();
    for (let start = 0; start < cap; start += 500) {
      const p = new URLSearchParams({ userId: user.jellyfin_user_id, recursive: 'true', filters: 'IsUnplayed', includeItemTypes: types, limit: '500', startIndex: String(start), enableTotalRecordCount: 'false', enableImages: 'false', enableUserData: 'false' });
      const r = await this.json<{ Items: Array<{ Id: string }> }>(user, `/Items?${p}`);
      r.Items.forEach((i) => out.add(i.Id));
      if (r.Items.length < 500) break;
    }
    return out;
  }

  /** Cast & crew for the X-Ray panel. */
  async people(user: JfUser, id: string): Promise<Array<{ id: string; name: string; role?: string; type: string; image: boolean }>> {
    const r = await this.json<{ Items: Array<{ People?: Array<{ Id: string; Name: string; Role?: string; Type: string; PrimaryImageTag?: string }> }> }>(user, `/Items?userId=${user.jellyfin_user_id}&ids=${id}&fields=People`);
    return (r.Items[0]?.People ?? []).slice(0, 40).map((p) => ({ id: p.Id, name: p.Name, role: p.Role, type: p.Type, image: Boolean(p.PrimaryImageTag) }));
  }

  /** Bonus material (featurettes, behind the scenes). */
  async extras(user: JfUser, id: string): Promise<ItemDto[]> {
    const res = await this.call(user, `/Items/${id}/SpecialFeatures?userId=${user.jellyfin_user_id}`);
    if (!res.ok) return [];
    const list = (await res.json().catch(() => [])) as any[];
    return (Array.isArray(list) ? list : []).map(toItemDto);
  }

  /** First local trailer (playable through the gateway). */
  async trailer(user: JfUser, id: string): Promise<string | null> {
    const res = await this.call(user, `/Items/${id}/LocalTrailers?userId=${user.jellyfin_user_id}`);
    if (!res.ok) return null;
    const list = (await res.json().catch(() => [])) as Array<{ Id: string }>;
    return Array.isArray(list) && list[0]?.Id ? list[0].Id : null;
  }

  async collections(user: JfUser): Promise<ItemDto[]> {
    const r = await this.json<{ Items: any[] }>(user, `/Items?userId=${user.jellyfin_user_id}&includeItemTypes=BoxSet&recursive=true&sortBy=SortName&fields=${FIELDS}&limit=100`);
    return r.Items.map(toItemDto);
  }

  async studios(user: JfUser): Promise<string[]> {
    const r = await this.json<{ Items: Array<{ Name: string }> }>(user, `/Studios?userId=${user.jellyfin_user_id}&includeItemTypes=Movie,Series&sortBy=SortName&limit=80&recursive=true`);
    return r.Items.map((s) => s.Name);
  }

  /** Remote subtitle providers (e.g. OpenSubtitles plugin). Uses the admin key: the portal checks item access first. */
  async searchSubtitles(id: string, lang: string): Promise<Array<{ id: string; name: string; provider: string; format?: string; downloads?: number; rating?: number }>> {
    const r = await this.client.adminJson<Array<Record<string, any>>>(`/Items/${id}/RemoteSearch/Subtitles/${lang}`);
    return r.slice(0, 25).map((s) => ({ id: String(s.Id), name: String(s.Name ?? ''), provider: String(s.ProviderName ?? ''), format: s.Format, downloads: s.DownloadCount, rating: s.CommunityRating }));
  }
  async downloadSubtitle(id: string, subtitleId: string) {
    await this.client.adminFetch(`/Items/${id}/RemoteSearch/Subtitles/${encodeURIComponent(subtitleId)}`, { method: 'POST' }).then((r) => {
      if (!r.ok) throw new JellyfinError(r.status, `subtitle download -> ${r.status}`);
    });
  }

  /** First regular episode of a series (used for the hover preview clip). */
  async firstEpisode(user: JfUser, seriesId: string): Promise<{ id: string; runtimeTicks?: number } | null> {
    const p = new URLSearchParams({ userId: user.jellyfin_user_id, limit: '1', fields: 'RunTimeTicks' });
    const res = await this.call(user, `/Shows/${seriesId}/Episodes?${p}`);
    if (!res.ok) return null;
    const r = (await res.json().catch(() => ({ Items: [] }))) as { Items?: Array<{ Id: string; RunTimeTicks?: number }> };
    const e = r.Items?.[0];
    return e?.Id ? { id: e.Id, runtimeTicks: e.RunTimeTicks } : null;
  }

  async seasons(user: JfUser, seriesId: string): Promise<ItemDto[]> {
    const r = await this.json<{ Items: any[] }>(user, `/Shows/${seriesId}/Seasons?userId=${user.jellyfin_user_id}&fields=${FIELDS}`);
    return r.Items.map(toItemDto);
  }

  async episodes(user: JfUser, seriesId: string, seasonId?: string): Promise<ItemDto[]> {
    const p = new URLSearchParams({ userId: user.jellyfin_user_id, fields: FIELDS });
    if (seasonId) p.set('seasonId', seasonId);
    const r = await this.json<{ Items: any[] }>(user, `/Shows/${seriesId}/Episodes?${p}`);
    return r.Items.map(toItemDto);
  }

  async upcoming(user: JfUser): Promise<ItemDto[]> {
    const r = await this.json<{ Items: any[] }>(user, `/Shows/Upcoming?userId=${user.jellyfin_user_id}&limit=50&fields=${FIELDS}`);
    return r.Items.map(toItemDto);
  }

  async setFavorite(user: JfUser, id: string, on: boolean) {
    const uid = user.jellyfin_user_id;
    await this.mutate(user, () => this.compat(user, 'favorite' + on, [`/UserFavoriteItems/${id}?userId=${uid}`, `/Users/${uid}/FavoriteItems/${id}`], { method: on ? 'POST' : 'DELETE' }));
  }

  async setPlayed(user: JfUser, id: string, on: boolean) {
    const uid = user.jellyfin_user_id;
    await this.mutate(user, () => this.compat(user, 'played' + on, [`/UserPlayedItems/${id}?userId=${uid}`, `/Users/${uid}/PlayedItems/${id}`], { method: on ? 'POST' : 'DELETE' }));
  }

  async playbackInfo(user: JfUser, itemId: string, opts: { maxBitrate: number; maxHeight?: number | null; startTicks?: number; audioIndex?: number; audioLang?: string; cast?: boolean; noDirect?: boolean }): Promise<PlaybackDto> {
    const p = new URLSearchParams({ UserId: user.jellyfin_user_id, MaxStreamingBitrate: String(opts.maxBitrate), AutoOpenLiveStream: 'false' });
    if (opts.startTicks) p.set('StartTimeTicks', String(opts.startTicks));
    if (opts.audioIndex !== undefined) p.set('AudioStreamIndex', String(opts.audioIndex));
    if (opts.maxHeight) {
      p.set('MaxHeight', String(opts.maxHeight));
      p.set('MaxWidth', String(maxWidthFor(opts.maxHeight)));
    }
    const heightCond = opts.maxHeight ? [{ Condition: 'LessThanEqual', Property: 'Height', Value: String(opts.maxHeight), IsRequired: true }] : [];
    const castCond = opts.cast
      ? [
          { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '41', IsRequired: true },
          { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: true },
        ]
      : [];
    if (opts.cast || opts.noDirect) {
      p.set('EnableDirectPlay', 'false');
      p.set('EnableDirectStream', 'false');
    }
    const profile = {
      Name: opts.cast ? 'FriendFlix Cast' : 'FriendFlix Web',
      MaxStreamingBitrate: opts.maxBitrate,
      CodecProfiles: heightCond.length || castCond.length ? [{ Type: 'Video', Codec: opts.cast ? 'h264' : undefined, Conditions: [...heightCond, ...castCond] }] : [],
      // Chromecast: never direct play; always HLS/TS with H.264 + stereo AAC
      DirectPlayProfiles: opts.cast || opts.noDirect ? [] : [{ Container: 'mp4,m4v,webm', Type: 'Video', VideoCodec: 'h264,vp9,av1', AudioCodec: 'aac,mp3,opus,flac' }],
      TranscodingProfiles: [
        { Container: 'ts', Type: 'Video', AudioCodec: opts.cast ? 'aac' : 'aac,mp3', VideoCodec: 'h264', Protocol: 'hls', Context: 'Streaming', MaxAudioChannels: '2', MinSegments: 1, BreakOnNonKeyFrames: true },
      ],
      SubtitleProfiles: [
        { Format: 'vtt', Method: 'External' },
        { Format: 'srt', Method: 'External' },
        { Format: 'ass', Method: 'External' },
      ],
    };
    const info = await this.json<Record<string, any>>(user, `/Items/${itemId}/PlaybackInfo?${p}`, {
      method: 'POST',
      body: JSON.stringify({ DeviceProfile: profile }),
    });
    if (info.ErrorCode) throw new JellyfinError(403, `playback blocked: ${info.ErrorCode}`);
    // preferred audio language: our HLS URL carries AudioStreamIndex itself, so a non-default track needs no second PlaybackInfo
    let audioIndex = opts.audioIndex;
    if (audioIndex === undefined && opts.audioLang) {
      const streams: Array<Record<string, any>> = info.MediaSources?.[0]?.MediaStreams ?? [];
      const want = streams.find((s) => s.Type === 'Audio' && s.Language === opts.audioLang);
      if (want && !want.IsDefault && typeof want.Index === 'number') audioIndex = want.Index;
    }
    return toPlaybackDto({ itemId, info, deviceId: this.deviceId(user), maxBitrate: opts.maxBitrate, resumeTicks: opts.startTicks ?? 0, audioIndex, maxHeight: opts.maxHeight, cast: opts.cast, noDirect: opts.noDirect });
  }

  /** PlaybackInfo with the "FriendFlix Download" profile: source details + (unless 'original') the fMP4 HLS master the preparer pulls. */
  async downloadSource(user: JfUser, itemId: string, opts: { quality: DownloadQuality; audioIndex?: number; maxHeight?: number | null; maxBitrate?: number | null }): Promise<DownloadSourceDto> {
    const original = opts.quality === 'original';
    const p = new URLSearchParams({ UserId: user.jellyfin_user_id, AutoOpenLiveStream: 'false' });
    if (opts.maxBitrate) p.set('MaxStreamingBitrate', String(opts.maxBitrate));
    if (opts.audioIndex !== undefined) p.set('AudioStreamIndex', String(opts.audioIndex));
    if (opts.maxHeight) {
      p.set('MaxHeight', String(opts.maxHeight));
      p.set('MaxWidth', String(maxWidthFor(opts.maxHeight)));
    }
    if (!original) {
      p.set('EnableDirectPlay', 'false');
      p.set('EnableDirectStream', 'false');
    }
    const conditions = [
      ...(opts.maxHeight ? [{ Condition: 'LessThanEqual', Property: 'Height', Value: String(opts.maxHeight), IsRequired: true }] : []),
      { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: true },
    ];
    const profile = {
      Name: 'FriendFlix Download',
      MaxStreamingBitrate: opts.maxBitrate ?? 120_000_000,
      CodecProfiles: [{ Type: 'Video', Codec: 'h264', Conditions: conditions }],
      DirectPlayProfiles: original ? [{ Container: 'mp4,m4v', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac,mp3' }] : [],
      TranscodingProfiles: [
        { Container: 'mp4', Type: 'Video', AudioCodec: 'aac', VideoCodec: 'h264', Protocol: 'hls', Context: 'Streaming', MaxAudioChannels: '2', MinSegments: 1, BreakOnNonKeyFrames: false },
      ],
      SubtitleProfiles: [{ Format: 'vtt', Method: 'External' }, { Format: 'srt', Method: 'External' }, { Format: 'ass', Method: 'External' }],
    };
    const info = await this.json<Record<string, any>>(user, `/Items/${itemId}/PlaybackInfo?${p}`, { method: 'POST', body: JSON.stringify({ DeviceProfile: profile }) });
    if (info.ErrorCode) throw new JellyfinError(403, `download blocked: ${info.ErrorCode}`);
    return toDownloadSource({ itemId, info, deviceId: this.deviceId(user), quality: opts.quality, audioIndex: opts.audioIndex, maxHeight: opts.maxHeight, maxBitrate: opts.maxBitrate });
  }

  /** Writes a user's resume position / played flag (offline progress sync). Current API first, legacy path as fallback. */
  async setUserData(user: JfUser, id: string, d: { positionTicks: number; played: boolean; lastPlayedDate: Date | string }): Promise<void> {
    const uid = user.jellyfin_user_id;
    const body = JSON.stringify({
      PlaybackPositionTicks: Math.max(0, Math.round(d.positionTicks)),
      Played: d.played,
      LastPlayedDate: (d.lastPlayedDate instanceof Date ? d.lastPlayedDate : new Date(d.lastPlayedDate)).toISOString(),
    });
    await this.mutate(user, () => this.compat(user, 'userdata', [`/UserItems/${id}/UserData?userId=${uid}`, `/Users/${uid}/Items/${id}/UserData`], { method: 'POST', body }));
  }

  /** Stops the server-side transcode behind a PlaySessionId (Jellyfin keeps encoding otherwise). Never throws. */
  async stopEncoding(user: JfUser, playSessionId: string): Promise<void> {
    await this.call(user, `/Videos/ActiveEncodings?${new URLSearchParams({ deviceId: this.deviceId(user), playSessionId })}`, { method: 'DELETE' }).catch(() => undefined);
  }

  /** Playing / Progress / Stopped reports (powers "Weiterschauen" and Jellyfin statistics). */
  async report(user: JfUser, kind: 'Playing' | 'Playing/Progress' | 'Playing/Stopped', body: Record<string, unknown>) {
    const res = await this.mutate(user, () => this.call(user, `/Sessions/${kind}`, { method: 'POST', body: JSON.stringify({ CanSeek: true, PlayMethod: 'DirectStream', ...body }) }));
    if (!res.ok) throw new JellyfinError(res.status, `report ${kind} -> ${res.status}`);
  }

  /** Library lookup by TMDB id with the admin key (used to link finished Seerr requests to library items). */
  async findByTmdb(tmdbId: number, mediaType: string): Promise<{ id: string; name: string } | null> {
    const type = mediaType === 'tv' ? 'Series' : 'Movie';
    const r = await this.client.adminJson<{ Items: Array<{ Id: string; Name: string }> }>(
      `/Items?anyProviderIdEquals=tmdb.${tmdbId}&recursive=true&includeItemTypes=${type}&limit=1`,
    );
    const i = r.Items[0];
    return i ? { id: i.Id, name: i.Name } : null;
  }
}
