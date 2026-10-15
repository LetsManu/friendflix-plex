// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { decrypt, encrypt } from '../crypto.js';
import type { KV } from '../kv.js';
import type {
  ClipTranscode, ExternalSession, IdentityPolicy, ItemDto, ItemMediaTraits, ItemQuery, ItemStreams, ItemTraits, MediaAdmin, MediaTraits, MediaCapabilities, MediaCredentials, MediaServer,
  MediaEvent, PersonDto, PlaybackDto, PlaybackReport, SegmentType,
} from '../media/types.js';
import type { JfUser } from '../types.js';
import { JellyfinClient, JellyfinError, mediaBrowserHeader, policyFromTemplate } from './client.js';
import { jellyfinWebhookEvents } from './webhook.js';
import { bestTraits, maxWidthFor, toDownloadSource, toItemDto, toMediaTraits, toPlaybackDto, toTrickplayDto, type DownloadQuality, type DownloadSourceDto } from './dto.js';
import { toChapters, toCredits, toItemAbout, toProviderIds } from './dto.js'; // Block 17 P1, Block 21
import { toHygieneFacts, toServerSession } from './dto.js'; // Block 22
import { MediaError } from '../media/types.js';
import type { ChapterDto, ItemAboutDto, ItemCreditsDto, MediaCollection } from '../media/types.js'; // Block 17 P1, Block 21
import type { HygieneFacts, ServerSession } from '../media/types.js'; // Block 22

const TOKEN_TTL = 6 * 3600;
const BOXSET_INDEX_KEY = 'jf:boxsets:v1';
const BOXSET_INDEX_TTL = 3600;
/** a partial index (some box set calls failed) is kept shorter, so a passing outage heals sooner */
const BOXSET_INDEX_PARTIAL_TTL = 600;
const BOXSET_INDEX_PARALLEL = 8;
/** item() memo: one detail page fires ~8 parallel requests that each load the same item (access check / data). */
export const ITEM_MEMO_TTL_MS = 10_000;
export const ITEM_MEMO_MAX = 2000;
const normId = (s: string) => s.replace(/-/g, '').toLowerCase();
const cloneItem = (i: ItemDto): ItemDto => ({ ...i, genres: [...i.genres], ...(i.imageTags ? { imageTags: { ...i.imageTags } } : {}) });
const FIELDS = 'Overview,Genres,OfficialRating,CommunityRating,PremiereDate,DateCreated,ProductionYear,ChildCount,RunTimeTicks,DateLastMediaAdded';

export type { ItemQuery };
const nid = (s: unknown) => String(s).replace(/-/g, '').toLowerCase();
const traitsOf = (i: Record<string, any>): ItemTraits => ({
  genres: Array.isArray(i.Genres) ? i.Genres : [], tags: Array.isArray(i.Tags) ? i.Tags : [], countries: Array.isArray(i.ProductionLocations) ? i.ProductionLocations : [],
});

/** Jellyfin (>= 10.10) can do everything FriendFlix offers. */
export const JELLYFIN_CAPABILITIES: MediaCapabilities = {
  segments: new Set<SegmentType>(['intro', 'outro', 'recap', 'preview']),
  trickplay: true, upcoming: true, subtitleSearch: true, webhooks: true, changeFeed: false, planB: true, subtitleExtract: false,
  chapters: true, // Block 17 P1
  requestUsers: 'jellyfin-import',
};

const REPORT_KIND = { start: 'Playing', progress: 'Playing/Progress', stop: 'Playing/Stopped' } as const;

/**
 * Per-user Jellyfin access. The portal logs in server-side (AuthenticateByName) with the
 * stored (encrypted) password, caches the user token (encrypted, in Redis) and re-authenticates
 * on 401. The token never leaves the backend/gateway.
 */
export class JellyfinService implements MediaServer {
  readonly kind = 'jellyfin';
  readonly capabilities = JELLYFIN_CAPABILITIES;
  readonly admin: MediaAdmin;

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
  ) {
    this.admin = this.makeAdmin();
  }

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

  async mediaAuth(user: JfUser): Promise<MediaCredentials> {
    return { token: await this.token(user), deviceId: this.deviceId(user) };
  }

  planBAuthHeader(cred: MediaCredentials): string {
    return mediaBrowserHeader({ deviceId: cred.deviceId, token: cred.token });
  }

  mediaFetch(user: JfUser, path: string, init: RequestInit = {}): Promise<Response> {
    return this.call(user, path, init);
  }

  /** The PlaybackInfo HLS master with forced re-encoding at the given limits (same session / device as `info`). */
  async clipTranscode(_user: JfUser, info: PlaybackDto, o: ClipTranscode): Promise<{ path: string; playSessionId: string }> {
    const master = new URL(info.hlsUrl.replace(/^\/media/, ''), 'http://jf.invalid');
    const q = master.searchParams;
    if (o.audioIndex !== undefined) q.set('AudioStreamIndex', String(o.audioIndex));
    const set: Record<string, string> = {
      ...(o.fmp4 ? { SegmentContainer: 'mp4', VideoCodec: 'h264', AudioCodec: 'aac' } : {}),
      AllowVideoStreamCopy: 'false', AllowAudioStreamCopy: 'false', VideoBitrate: String(o.videoBitrate), AudioBitrate: String(o.audioBitrate), MaxWidth: String(o.maxWidth),
      ...(o.stereo ? { TranscodingMaxAudioChannels: '2' } : {}),
      ...(o.maxBitrate ? { MaxStreamingBitrate: String(o.maxBitrate) } : {}),
    };
    for (const [k, v] of Object.entries(set)) q.set(k, v);
    return { path: master.pathname + master.search, playSessionId: q.get('PlaySessionId') ?? info.playSessionId };
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
    if (q.tag) p.set('tags', q.tag);
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

  /** A person page's header; null when the id is no person. */
  async person(user: JfUser, id: string): Promise<PersonDto | null> {
    const uid = user.jellyfin_user_id;
    const raw = await this.compat<Record<string, any>>(user, 'item', [`/Items/${id}?userId=${uid}`, `/Users/${uid}/Items/${id}`]);
    if (raw.Type !== 'Person') return null;
    const birth = raw.PremiereDate ? new Date(raw.PremiereDate).getUTCFullYear() : NaN;
    return {
      id: raw.Id as string, name: raw.Name as string,
      ...(raw.Overview ? { overview: raw.Overview as string } : {}),
      ...(Number.isFinite(birth) ? { birthYear: birth } : {}),
      image: Boolean(raw.ImageTags?.Primary),
    };
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
  async playMeta(user: JfUser, itemId: string): Promise<{ positionTicks: number; trickplay: (mediaSourceId: string) => ReturnType<typeof toTrickplayDto> } | null> {
    try {
      const r = await this.json<{ Items: Array<{ Trickplay?: Record<string, any>; UserData?: { PlaybackPositionTicks?: number } }> }>(
        user, `/Items?userId=${user.jellyfin_user_id}&ids=${itemId}&fields=Trickplay&enableUserData=true`);
      const it = r.Items[0];
      if (!it) return null;
      return { positionTicks: Number(it.UserData?.PlaybackPositionTicks ?? 0), trickplay: (ms) => toTrickplayDto(itemId, ms, it.Trickplay) };
    } catch {
      return null;
    }
  }

  /** "Ähnliche Titel" from Jellyfin's own similarity (genres/people/tags). */
  async similar(user: JfUser, id: string, limit = 24): Promise<ItemDto[]> {
    const r = await this.json<{ Items?: any[] }>(user, `/Items/${id}/Similar?userId=${user.jellyfin_user_id}&limit=${limit}&fields=${FIELDS}`);
    // each title once (the detail page lists them in a keyed block: a repeated id would break its render)
    const seen = new Set<string>();
    return (Array.isArray(r?.Items) ? r.Items : []).filter((i) => typeof i?.Id === 'string' && !seen.has(i.Id) && seen.add(i.Id)).map(toItemDto);
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

  /** Cast & crew for the cast panel. */
  async people(user: JfUser, id: string): Promise<Array<{ id: string; name: string; role?: string; type: string; image: boolean }>> {
    const r = await this.json<{ Items?: Array<{ People?: unknown }> }>(user, `/Items?userId=${user.jellyfin_user_id}&ids=${id}&fields=People`);
    // same rules as toCredits(): an entry needs a string id and name (Jellyfin can send Name null), a missing type reads as Actor
    return toCredits({ People: r?.Items?.[0]?.People }).people.slice(0, 40);
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

  /** All local trailers as items (Extras tab). */
  async trailers(user: JfUser, id: string): Promise<ItemDto[]> {
    const res = await this.call(user, `/Items/${id}/LocalTrailers?userId=${user.jellyfin_user_id}`);
    if (!res.ok) return [];
    const j = (await res.json().catch(() => [])) as unknown;
    return Array.isArray(j) ? j.map(toItemDto) : [];
  }

  async facets(user: JfUser, kind: 'studio' | 'genre'): Promise<Array<{ name: string; count: number }>> {
    const path = kind === 'studio' ? '/Studios' : '/Genres';
    const r = await this.json<{ Items: Array<{ Name: string; MovieCount?: number; SeriesCount?: number; ChildCount?: number }> }>(user,
      `${path}?userId=${user.jellyfin_user_id}&includeItemTypes=Movie,Series&recursive=true&fields=ItemCounts&limit=200`).catch(() => ({ Items: [] }));
    return r.Items.map((x) => ({ name: x.Name, count: (x.MovieCount ?? 0) + (x.SeriesCount ?? 0) || x.ChildCount || 0 }));
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

  /** Newest movies + episodes by library date (weekly digest). */
  async addedItems(user: JfUser, page: { start: number; limit: number }): Promise<ItemDto[]> {
    const p = new URLSearchParams({
      userId: user.jellyfin_user_id, recursive: 'true', includeItemTypes: 'Movie,Episode', sortBy: 'DateCreated', sortOrder: 'Descending',
      limit: String(page.limit), startIndex: String(page.start), fields: 'DateCreated,PremiereDate,ProductionYear',
    });
    const r = await this.json<{ Items?: any[] }>(user, `/Items?${p}`);
    return (r.Items ?? []).map(toItemDto);
  }

  async itemTraits(user: JfUser, id: string): Promise<ItemTraits | null> {
    const qs = new URLSearchParams({ userId: user.jellyfin_user_id, ids: id, includeItemTypes: 'Series', recursive: 'true', fields: 'Genres,Tags,ProductionLocations', enableImages: 'false', enableUserData: 'false' });
    const r = await this.json<{ Items?: any[] }>(user, `/Items?${qs}`);
    const s = (r.Items ?? []).find((x) => nid(x.Id) === id);
    return s ? traitsOf(s) : null;
  }

  async continuingSeries(user: JfUser): Promise<Array<{ item: ItemDto; traits: ItemTraits }>> {
    const sp = new URLSearchParams({
      userId: user.jellyfin_user_id, recursive: 'true', includeItemTypes: 'Series', seriesStatus: 'Continuing', limit: '300', sortBy: 'SortName',
      fields: 'Overview,Genres,Tags,ProductionLocations,OfficialRating,CommunityRating,PremiereDate,ProductionYear,ChildCount',
    });
    const r = await this.json<{ Items: any[] }>(user, `/Items?${sp}`);
    return (r.Items ?? []).map((s) => ({ item: toItemDto(s), traits: traitsOf(s) }));
  }

  async premieringEpisodes(user: JfUser, from: string, to: string): Promise<ItemDto[]> {
    const ep = new URLSearchParams({
      userId: user.jellyfin_user_id, recursive: 'true', includeItemTypes: 'Episode', minPremiereDate: from, maxPremiereDate: to, sortBy: 'PremiereDate', sortOrder: 'Descending', limit: '600',
      fields: 'PremiereDate', enableUserData: 'false', enableImages: 'false', enableTotalRecordCount: 'false',
    });
    const r = await this.json<{ Items: any[] }>(user, `/Items?${ep}`);
    return (r.Items ?? []).map(toItemDto);
  }

  /** A real (non-placeholder) episode: Jellyfin lists announced episodes as Virtual / missing. */
  async availableEpisodes(user: JfUser, ids: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (!ids.length) return out;
    const p = new URLSearchParams({ userId: user.jellyfin_user_id, ids: ids.join(','), isMissing: 'false', recursive: 'true', includeItemTypes: 'Episode', fields: 'LocationType' });
    const r = await this.json<{ Items?: Array<{ Id: string; LocationType?: string }> }>(user, `/Items?${p}`);
    for (const i of r.Items ?? []) if (i.LocationType !== 'Virtual') out.add(i.Id);
    return out;
  }

  /** Jellyfin gives an episode a NEW id when its file arrives (the announced one was a placeholder): find it by season + number. */
  async seasonEpisodeIds(user: JfUser, seriesId: string, season: number): Promise<Map<number, string>> {
    const p = new URLSearchParams({ userId: user.jellyfin_user_id, season: String(season), isMissing: 'false', fields: 'LocationType' });
    const r = await this.json<{ Items?: Array<{ Id: string; IndexNumber?: number; LocationType?: string }> }>(user, `/Shows/${seriesId}/Episodes?${p}`);
    const out = new Map<number, string>();
    for (const i of r.Items ?? []) if (i.LocationType !== 'Virtual' && i.IndexNumber != null && !out.has(i.IndexNumber)) out.set(i.IndexNumber, i.Id);
    return out;
  }

  async setFavorite(user: JfUser, id: string, on: boolean) {
    const uid = user.jellyfin_user_id;
    await this.mutate(user, () => this.compat(user, 'favorite' + on, [`/UserFavoriteItems/${id}?userId=${uid}`, `/Users/${uid}/FavoriteItems/${id}`], { method: on ? 'POST' : 'DELETE' }));
  }

  async setPlayed(user: JfUser, id: string, on: boolean) {
    const uid = user.jellyfin_user_id;
    await this.mutate(user, () => this.compat(user, 'played' + on, [`/UserPlayedItems/${id}?userId=${uid}`, `/Users/${uid}/PlayedItems/${id}`], { method: on ? 'POST' : 'DELETE' }));
  }

  async playbackInfo(user: JfUser, itemId: string, opts: { maxBitrate: number; maxHeight?: number | null; startTicks?: number; audioIndex?: number; audioLang?: string; cast?: boolean; noDirect?: boolean; capReason?: 'remoteCap' | 'roleCap' | 'manual' | 'network' }): Promise<PlaybackDto> {
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
    return toPlaybackDto({ itemId, info, deviceId: this.deviceId(user), maxBitrate: opts.maxBitrate, resumeTicks: opts.startTicks ?? 0, audioIndex, maxHeight: opts.maxHeight, cast: opts.cast, noDirect: opts.noDirect, capReason: opts.capReason });
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

  /** Jellyfin converts text subtitles to WebVTT itself (the same stream the gateway serves at the DTO's subtitle URL). */
  subtitleStream(user: JfUser, itemId: string, mediaSourceId: string, streamIndex: number, format: 'vtt'): Promise<Response> {
    return this.call(user, `/Videos/${itemId}/${encodeURIComponent(mediaSourceId)}/Subtitles/${streamIndex}/0/Stream.${format}`);
  }

  webhookEvents(body: unknown): MediaEvent[] | null {
    return jellyfinWebhookEvents(body);
  }

  /** Stops the server-side transcode behind a PlaySessionId (Jellyfin keeps encoding otherwise). Never throws. */
  async stopEncoding(user: JfUser, playSessionId: string): Promise<void> {
    await this.call(user, `/Videos/ActiveEncodings?${new URLSearchParams({ deviceId: this.deviceId(user), playSessionId })}`, { method: 'DELETE' }).catch(() => undefined);
  }

  /** Playing / Progress / Stopped reports (powers "Weiterschauen" and Jellyfin statistics). */
  async report(user: JfUser, r: PlaybackReport) {
    const kind = REPORT_KIND[r.event];
    const { PlayMethod, ...rest } = {
      ItemId: r.itemId, MediaSourceId: r.mediaSourceId, PlaySessionId: r.playSessionId, PositionTicks: r.positionTicks, IsPaused: r.paused,
      AudioStreamIndex: r.audioIndex, SubtitleStreamIndex: r.subtitleIndex, PlayMethod: r.playMethod ?? 'DirectStream',
    };
    const res = await this.mutate(user, () => this.call(user, `/Sessions/${kind}`, { method: 'POST', body: JSON.stringify({ CanSeek: true, PlayMethod, ...rest }) }));
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

  /** A series counts as available once at least one real (non-placeholder) episode exists. */
  async seriesHasEpisode(seriesId: string): Promise<boolean> {
    const p = new URLSearchParams({ parentId: seriesId, recursive: 'true', includeItemTypes: 'Episode', isMissing: 'false', limit: '1', fields: 'LocationType' });
    const r = await this.client.adminJson<{ Items?: Array<{ LocationType?: string }> }>(`/Items?${p}`);
    return (r.Items ?? []).some((i) => i.LocationType !== 'Virtual');
  }

  async libraryStreams(type: 'Movie' | 'Episode', start: number, limit: number): Promise<ItemStreams[]> {
    const fields = type === 'Episode' ? 'MediaStreams,SeriesId' : 'MediaStreams';
    const r = await this.client.adminJson<{ Items?: any[] }>(
      `/Items?recursive=true&includeItemTypes=${type}&fields=${fields}&enableImages=false&enableUserData=false&startIndex=${start}&limit=${limit}`,
    );
    return (r?.Items ?? []).map((item) => {
      const streams: any[] = Array.isArray(item?.MediaStreams) && item.MediaStreams.length ? item.MediaStreams : (item?.MediaSources?.[0]?.MediaStreams ?? []);
      const langs = (kind: string) => streams.filter((s) => s?.Type === kind && s.Language != null).map((s) => s.Language);
      return { id: item?.Id, seriesId: item?.SeriesId, audio: langs('Audio'), subtitles: langs('Subtitle') };
    });
  }

  // ---- Block 22: admin care (library hygiene, metadata refresh) ----
  /** One page of hygiene facts of the whole library (admin key), stable order; `savedSince` -> minDateLastSaved (incremental scans). */
  async libraryHygiene(type: 'Movie' | 'Series' | 'Episode', page: { start: number; limit: number; savedSince?: string }): Promise<HygieneFacts[]> {
    const p = new URLSearchParams({
      recursive: 'true', includeItemTypes: type, fields: 'Overview,ProviderIds,MediaSources,ProductionYear,PremiereDate,SeriesId',
      enableUserData: 'false', enableImageTypes: 'Primary,Backdrop', imageTypeLimit: '1', sortBy: 'SortName,Id', sortOrder: 'Ascending',
      startIndex: String(page.start), limit: String(page.limit), enableTotalRecordCount: 'false',
    });
    if (page.savedSince) p.set('minDateLastSaved', page.savedSince);
    const r = await this.client.adminJson<{ Items?: any[] }>(`/Items?${p}`);
    return (r?.Items ?? []).filter((i) => i?.Id).map((i) => toHygieneFacts(i, type));
  }

  /** Full metadata + image refresh of one item (admin key), keeping what is there; MediaError(404) for an unknown id. */
  async refreshMetadata(id: string): Promise<void> {
    const p = new URLSearchParams({ metadataRefreshMode: 'FullRefresh', imageRefreshMode: 'FullRefresh', replaceAllMetadata: 'false', replaceAllImages: 'false' });
    const res = await this.client.adminFetch(`/Items/${encodeURIComponent(id)}/Refresh?${p}`, { method: 'POST' });
    if (!res.ok) throw new JellyfinError(res.status === 404 ? 404 : 502, `Jellyfin refresh -> ${res.status}`);
  }

  // ---- Block 17 D1: media traits (quality chips, 4K / HDR filter) ----
  /** Best video / audio of a title as the viewer sees it; a series reports its best (first few) episodes. null = not visible / no video. */
  async mediaTraits(user: JfUser, id: string): Promise<MediaTraits | null> {
    const p = new URLSearchParams({ userId: user.jellyfin_user_id, ids: id, fields: 'MediaStreams', enableImages: 'false', enableUserData: 'false' });
    const r = await this.json<{ Items?: any[] }>(user, `/Items?${p}`);
    const it = (r.Items ?? []).find((x) => nid(x.Id) === id);
    if (!it) return null;
    const own = (x: any) => toMediaTraits(Array.isArray(x?.MediaStreams) && x.MediaStreams.length ? x.MediaStreams : x?.MediaSources?.[0]?.MediaStreams);
    if (it.Type !== 'Series') return own(it);
    // a series has no streams of its own: look at its first episodes (cheap, and the first ones are usually representative)
    const ep = new URLSearchParams({ userId: user.jellyfin_user_id, limit: '3', fields: 'MediaStreams', enableImages: 'false', enableUserData: 'false', isMissing: 'false' });
    const e = await this.json<{ Items?: any[] }>(user, `/Shows/${id}/Episodes?${ep}`);
    return (e.Items ?? []).reduce<MediaTraits | null>((acc, x) => bestTraits(acc, own(x)), null);
  }

  async libraryMediaTraits(type: 'Movie' | 'Episode', start: number, limit: number): Promise<ItemMediaTraits[]> {
    const fields = type === 'Episode' ? 'MediaStreams,SeriesId' : 'MediaStreams';
    const r = await this.client.adminJson<{ Items?: any[] }>(
      // stable order (SortName, then Id as tie-breaker): pages taken while the library changes must not skip / repeat items
      `/Items?recursive=true&includeItemTypes=${type}&fields=${fields}&enableImages=false&enableUserData=false&sortBy=SortName,Id&sortOrder=Ascending&startIndex=${start}&limit=${limit}`,
    );
    const out: ItemMediaTraits[] = [];
    for (const item of r?.Items ?? []) {
      const traits = toMediaTraits(Array.isArray(item?.MediaStreams) && item.MediaStreams.length ? item.MediaStreams : item?.MediaSources?.[0]?.MediaStreams);
      if (item?.Id && traits) out.push({ id: item.Id, seriesId: item.SeriesId, traits });
      else if (item?.Id) out.push({ id: item.Id, seriesId: item.SeriesId, traits: { resolution: 'sd', hdr: null, audio: null } }); // keeps page lengths honest (short page = end)
    }
    return out;
  }

  /** One page of ALL continuing series ids (admin key: library-wide, independent of any viewer's parental limits); short page = end. */
  async libraryContinuingSeriesIds(start: number, limit: number): Promise<string[]> {
    const p = new URLSearchParams({
      recursive: 'true', includeItemTypes: 'Series', seriesStatus: 'Continuing', sortBy: 'SortName,Id', sortOrder: 'Ascending',
      startIndex: String(start), limit: String(limit), enableImages: 'false', enableUserData: 'false', enableTotalRecordCount: 'false',
    });
    const r = await this.client.adminJson<{ Items?: Array<{ Id?: string }> }>(`/Items?${p}`);
    return (r?.Items ?? []).flatMap((i) => (i?.Id ? [nid(i.Id)] : []));
  }

  // ---- Block 17 P1: chapters + credits (player "Szenen" panel, "Besetzung & Infos") ----
  /** Chapter marks (+ stills) as the viewer sees the item; 404 when it is not visible to them. */
  async chapters(user: JfUser, id: string): Promise<ChapterDto[]> {
    const p = new URLSearchParams({ userId: user.jellyfin_user_id, ids: id, fields: 'Chapters', enableImages: 'false', enableUserData: 'false' });
    const r = await this.json<{ Items?: any[] }>(user, `/Items?${p}`);
    const it = (r.Items ?? []).find((x) => nid(x.Id) === id);
    if (!it) throw new JellyfinError(404, 'Jellyfin: item not visible');
    return toChapters(id, it.Chapters);
  }

  /** People (with character names and guest stars), studios and tags of one item; 404 when it is not visible. */
  async credits(user: JfUser, id: string): Promise<ItemCreditsDto> {
    const p = new URLSearchParams({ userId: user.jellyfin_user_id, ids: id, fields: 'People,Studios,Tags', enableImages: 'false', enableUserData: 'false' });
    const r = await this.json<{ Items?: any[] }>(user, `/Items?${p}`);
    const it = (r.Items ?? []).find((x) => nid(x.Id) === id);
    if (!it) throw new JellyfinError(404, 'Jellyfin: item not visible');
    return toCredits(it);
  }

  // ---- Block 21: detail page ("Über", collections) ----
  /** Tagline, original title, countries, studios, tags, provider ids and ratings as the viewer sees the item; 404 when not visible. */
  async itemAbout(user: JfUser, id: string): Promise<ItemAboutDto> {
    const p = new URLSearchParams({ userId: user.jellyfin_user_id, ids: id, fields: 'ProviderIds,Taglines,Studios,Tags,ProductionLocations,OriginalTitle,Genres', enableImages: 'false' });
    const r = await this.json<{ Items?: any[] }>(user, `/Items?${p}`);
    const it = (r.Items ?? []).find((x) => nid(x.Id) === nid(id));
    if (!it) throw new MediaError(404, 'Jellyfin: item not visible');
    return toItemAbout(it);
  }

  private boxsetIndexBuild: Promise<Record<string, string[]>> | null = null;
  /** Library-wide box set membership (admin key, independent of any viewer): box set id -> normalised child ids. kv-cached, single-flight. */
  private boxsetIndex(): Promise<Record<string, string[]>> {
    if (this.boxsetIndexBuild) return this.boxsetIndexBuild;
    const build = (async () => {
      const cached = await this.kv.get(BOXSET_INDEX_KEY).catch(() => null);
      if (cached) { try { return JSON.parse(cached) as Record<string, string[]>; } catch { /* rebuild */ } }
      const sets: string[] = [];
      for (let start = 0; ; start += 200) {
        const p = new URLSearchParams({ recursive: 'true', includeItemTypes: 'BoxSet', sortBy: 'SortName,Id', sortOrder: 'Ascending', startIndex: String(start), limit: '200', fields: '', enableImages: 'false', enableUserData: 'false' });
        const r = await this.client.adminJson<{ Items?: Array<{ Id?: string }> }>(`/Items?${p}`);
        const page = (r?.Items ?? []).flatMap((i) => (i?.Id ? [i.Id] : []));
        sets.push(...page);
        if (page.length < 200) break;
      }
      // bounded parallelism; a box set whose call fails is left out (the rest still counts and is cached)
      const index: Record<string, string[]> = {};
      for (let i = 0; i < sets.length; i += BOXSET_INDEX_PARALLEL) {
        await Promise.all(sets.slice(i, i + BOXSET_INDEX_PARALLEL).map(async (b) => {
          try {
            const p = new URLSearchParams({ parentId: b, fields: '', enableImages: 'false', enableUserData: 'false' });
            const r = await this.client.adminJson<{ Items?: Array<{ Id?: string }> }>(`/Items?${p}`);
            index[b] = (r?.Items ?? []).flatMap((it) => (it?.Id ? [nid(it.Id)] : []));
          } catch { /* skipped */ }
        }));
      }
      const ordered = Object.fromEntries(sets.flatMap((b) => (index[b] ? [[b, index[b]] as const] : [])));
      await this.kv.set(BOXSET_INDEX_KEY, JSON.stringify(ordered), Object.keys(ordered).length < sets.length ? BOXSET_INDEX_PARTIAL_TTL : BOXSET_INDEX_TTL).catch(() => undefined);
      return ordered;
    })();
    this.boxsetIndexBuild = build;
    const clear = () => { if (this.boxsetIndexBuild === build) this.boxsetIndexBuild = null; };
    build.then(clear, clear);
    return build;
  }

  /** Box sets containing the item; name and parts come from the viewer's own identity (role libraries, age cap, kids apply). */
  async itemCollections(user: JfUser, id: string): Promise<MediaCollection[]> {
    const want = nid(id);
    const index = await this.boxsetIndex();
    const out: MediaCollection[] = [];
    for (const [boxId, children] of Object.entries(index)) {
      if (!children.includes(want)) continue;
      try {
        const named = await this.json<{ Items?: any[] }>(user, `/Items?${new URLSearchParams({ userId: user.jellyfin_user_id, ids: boxId, enableImages: 'false', enableUserData: 'false' })}`);
        const box = (named.Items ?? []).find((x) => nid(x.Id) === nid(boxId));
        if (!box || typeof box.Name !== 'string') continue; // not visible to the viewer: neither the name nor the parts show up
        const p = new URLSearchParams({ userId: user.jellyfin_user_id, parentId: boxId, fields: `${FIELDS},ProviderIds`, sortBy: 'PremiereDate,ProductionYear,SortName', sortOrder: 'Ascending' });
        const r = await this.json<{ Items?: any[] }>(user, `/Items?${p}`);
        const rawParts = (r.Items ?? []).filter((x) => x?.Id);
        const key = (x: any) => [String(x.PremiereDate ?? '9999'), Number(x.ProductionYear ?? 9999), String(x.Name ?? '')] as const;
        rawParts.sort((a, b) => { const [ad, ay, an] = key(a), [bd, by, bn] = key(b); return ad < bd ? -1 : ad > bd ? 1 : ay - by || an.localeCompare(bn); });
        const parts = rawParts.map((x) => { const tmdb = toProviderIds(x.ProviderIds).tmdb; return { item: toItemDto(x), ...(tmdb ? { tmdbId: tmdb } : {}) }; });
        if (parts.length) out.push({ id: boxId, name: box.Name, parts });
      } catch (e) {
        if (e instanceof MediaError) continue; // a non-ok answer skips that box set
        throw e;
      }
    }
    return out;
  }

  private makeAdmin(): MediaAdmin {
    const client = this.client;
    return {
      createIdentity: async (name, password) => ({ id: (await client.createUser(name, password)).Id }),
      deleteIdentity: async (id) => {
        const res = await client.adminFetch(`/Users/${id}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 404) throw new JellyfinError(res.status, `Jellyfin delete user -> ${res.status}`);
      },
      /** Resolves the template's library names to media folder ids and merges our managed fields into the Jellyfin policy. */
      applyPolicy: async (id, p: IdentityPolicy) => {
        const t = p.template;
        let ids: string[] | null = null;
        if (t.libraries !== 'all') {
          const folders = await client.mediaFolders();
          const want = new Set(t.libraries.map((n) => n.toLowerCase()));
          ids = folders.filter((f) => want.has(f.Name.toLowerCase())).map((f) => f.Id);
        }
        const parental = p.parental
          ? { ...(p.parental.maxRating !== undefined ? { MaxParentalRating: p.parental.maxRating } : {}), BlockUnratedItems: p.parental.blockUnrated }
          : {};
        await client.setPolicy(id, { ...policyFromTemplate(t, ids), IsDisabled: p.disabled, ...(p.hidden ? { IsHidden: true } : {}), ...parental });
      },
      setDisabled: (id, disabled) => client.setPolicy(id, { IsDisabled: disabled }),
      identityExists: async (id) => {
        const res = await client.adminFetch(`/Users/${id}`);
        await res.body?.cancel().catch(() => undefined);
        if (res.status === 404) return false;
        if (!res.ok) throw new JellyfinError(res.status, `Jellyfin get user -> ${res.status}`);
        return true;
      },
      libraries: async () => (await client.mediaFolders()).map((f) => ({ id: f.Id, name: f.Name })),
      ping: () => client.ping(),
      /** sessions of other apps: FriendFlix' own devices ("ff-<id>") are tracked by the portal itself */
      externalSessions: async (): Promise<ExternalSession[]> => (await client.sessions())
        .filter((s) => s.NowPlayingItem && !String(s.DeviceId ?? '').startsWith('ff-'))
        .map((s) => {
          const d = toServerSession(s); // Block 22: client, play method, reasons (whitelisted fields only)
          return {
            sessionId: String(s.Id), serverUserId: String(s.UserId), positionTicks: s.PlayState?.PositionTicks ?? 0, isPaused: Boolean(s.PlayState?.IsPaused),
            item: { id: s.NowPlayingItem.Id, name: s.NowPlayingItem.Name, seriesName: s.NowPlayingItem.SeriesName, type: s.NowPlayingItem.Type, runtimeTicks: s.NowPlayingItem.RunTimeTicks },
            ...(d ? { client: d.client, playMethod: d.playMethod, reasons: d.reasons } : {}),
          };
        }),
      /** Block 22: every playing session (FriendFlix devices included) with play method, reasons, codecs and hardware flag */
      transcodeSessions: async (): Promise<ServerSession[]> => (await client.allSessions()).flatMap((s) => {
        const d = toServerSession(s);
        return d ? [d] : [];
      }),
    };
  }
}
