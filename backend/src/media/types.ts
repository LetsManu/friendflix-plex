/**
 * The media server seam. Routes and jobs only talk to a `MediaServer` (ctx.jf); the Jellyfin implementation lives in
 * ../jellyfin/*. Another implementation (a fork) adds its own directory plus one entry in ./index.ts. Everything here is
 * server-neutral: normalized DTOs, capability flags and the error base class. Item ids are 32 lower-case hex chars and item
 * types use the FriendFlix vocabulary 'Movie' | 'Series' | 'Season' | 'Episode' | 'BoxSet' | 'Person' (sort keys likewise:
 * 'SortName', 'DateCreated', 'PremiereDate', 'CommunityRating', 'PlayCount', 'DatePlayed', 'Random', comma-combinable).
 * See docs/architecture.md, "Media server seam".
 */
import type { RoleTemplate } from '../roles.js';
import type { JfUser } from '../types.js';

/** A FriendFlix identity on the media server: an account's own row or a (non-owner) profile's credentials. */
export type MediaUser = JfUser;

/** Upstream failure (HTTP-like status). Routes map it via _shared.wrap: listed statuses -> 404, others -> 502 {error:'jellyfin'}. */
export class MediaError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------- capabilities

export type SegmentType = 'intro' | 'outro' | 'recap' | 'preview';
export const SEGMENT_TYPES: readonly SegmentType[] = ['intro', 'outro', 'recap', 'preview'];

/** What the configured server can do. The web hides UI for anything unsupported (Jellyfin: everything supported). */
export interface MediaCapabilities {
  /** skip-segment types the server reports (intro/outro/recap/preview) */
  segments: ReadonlySet<SegmentType>;
  /** timeline preview thumbnails */
  trickplay: boolean;
  /** announced (not yet available) episodes: calendar / "new episode" notifications */
  upcoming: boolean;
  /** remote subtitle search + download (OpenSubtitles plugin etc.) */
  subtitleSearch: boolean;
  /** the server pushes playback / library events to /internal/webhook/<kind> */
  webhooks: boolean;
  /** library change feed other than webhooks (e.g. websocket / polling) */
  changeFeed: boolean;
  /** Plan B (nginx auth_request straight to the server) is possible */
  planB: boolean;
  /**
   * text subtitles are served by FriendFlix itself (subtitleStream() behind GET /api/items/:id/subtitle/:ms/:index/stream.vtt) because
   * the server cannot deliver them as WebVTT; PlaybackDto subtitle URLs then point there. false: the gateway path of the DTO.
   */
  subtitleExtract: boolean;
  /**
   * Block 17 P1: chapter marks (names, optional stills) via chapters(): seek bar marks + the player's "Szenen" panel.
   * Optional so implementations written before Block 17 (a Plex fork) still compile; absent = false.
   */
  chapters?: boolean;
  /**
   * How FriendFlix accounts become Seerr users for wishes (backend only, not sent to the web). 'jellyfin-import': find the
   * account's Jellyfin user in Seerr (import it via /user/import-from-jellyfin). 'local' (also when absent): a local Seerr user
   * per account, found by the stored id or by email, else created with the REQUEST permission (seerr/service.ts).
   */
  requestUsers?: 'jellyfin-import' | 'local';
}

/** JSON form of the capabilities (sets as arrays), as sent to the web in /api/me and /api/server. */
export const publicCapabilities = (c: MediaCapabilities) => ({
  segments: SEGMENT_TYPES.filter((s) => c.segments.has(s)),
  trickplay: c.trickplay, upcoming: c.upcoming, subtitleSearch: c.subtitleSearch, webhooks: c.webhooks, changeFeed: c.changeFeed, planB: c.planB,
  subtitleExtract: c.subtitleExtract, chapters: c.chapters ?? false,
});

// ---------------------------------------------------------------- DTOs

/** Trimmed item shape sent to the browser (never raw server JSON, no tokens, no server paths). */
export interface ItemDto {
  id: string;
  name: string;
  type: string;
  year?: number;
  overview?: string;
  runtimeTicks?: number;
  seriesId?: string;
  seriesName?: string;
  seasonId?: string;
  indexNumber?: number;
  parentIndexNumber?: number;
  genres: string[];
  rating?: string;
  communityRating?: number;
  premiereDate?: string;
  /** when the item was added to the library (Jellyfin DateCreated) */
  dateCreated?: string;
  image: boolean;
  backdrop: boolean;
  /** transparent title logo available (shown in the billboard) */
  logo: boolean;
  /** number of local (playable) trailers */
  trailers: number;
  played: boolean;
  favorite: boolean;
  positionTicks: number;
  playedPercentage?: number;
  /** ISO timestamp of the viewer's last playback (UserData.LastPlayedDate) */
  lastPlayedDate?: string;
  childCount?: number;
  unplayedCount?: number;
  /** ISO timestamp when media was last added (new episodes for a series) */
  lastAdded?: string;
  /**
   * Image tags (change whenever the image changes). Sent as `&tag=<tag>` on /media/Items/<id>/Images/<Kind> URLs, they
   * let the gateway mark the image immutable. Keys are only present when the image exists; `seriesPrimary` is the series poster
   * of an episode (/media/Items/<seriesId>/Images/Primary). The booleans above stay for older clients.
   */
  imageTags?: ImageTags;
}

export interface ImageTags {
  primary?: string;
  backdrop?: string;
  logo?: string;
  thumb?: string;
  seriesPrimary?: string;
}

export interface PlaybackDto {
  itemId: string;
  playSessionId: string;
  mediaSourceId: string;
  directUrl?: string;
  hlsUrl: string;
  runtimeTicks?: number;
  resumeTicks: number;
  /** bitrate cap used for this session (<= role limit) */
  maxBitrate: number;
  /** role limit, upper bound for the quality menu */
  roleMaxBitrate?: number;
  /** audio track baked into hlsUrl (explicit audioIndex or the matched audioLang); undefined = source default */
  audioIndex?: number;
  trickplay?: TrickplayDto;
  audioTracks: Array<{ index: number; language?: string; title: string; isDefault: boolean }>;
  subtitles: Array<{ index: number; language?: string; title: string; url: string; isDefault: boolean }>;
}

/** 16:9 width for a height cap (1080 -> 1920) */
export const maxWidthFor = (h: number) => Math.round((h * 16) / 9 / 2) * 2;

/** Timeline preview thumbnails: tile sheets of tileWidth x tileHeight thumbnails. */
export interface TrickplayDto {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  count: number;
  /** ms between thumbnails */
  interval: number;
  /** URL with {n} = sheet index */
  url: string;
}

export type DownloadQuality = 'sd' | 'hd' | 'fhd' | 'original';
/** Server-side preparation presets (video + audio bits per second); roles clamp height/bitrate on top. */
export const DOWNLOAD_PRESETS: Record<Exclude<DownloadQuality, 'original'>, { height: number; videoBps: number; audioBps: number }> = {
  sd: { height: 480, videoBps: 1_000_000, audioBps: 128_000 },
  hd: { height: 720, videoBps: 2_500_000, audioBps: 128_000 },
  fhd: { height: 1080, videoBps: 5_000_000, audioBps: 160_000 },
};

export interface DownloadSourceDto {
  mediaSourceId: string;
  /** mp4/m4v + 8-bit H.264 + AAC/MP3 within the caps: the gateway may proxy the file as is */
  originalEligible: boolean;
  sizeBytes: number;
  runtimeTicks?: number;
  audio: Array<{ index: number; lang: string; title: string; isDefault: boolean }>;
  subtitles: Array<{ index: number; lang: string; title: string; url: string }>;
  /** server-relative HLS master (fMP4 segments, no /media prefix) for server-side preparation (fetch via mediaFetch); absent for 'original' */
  masterPath?: string;
  playSessionId: string;
}

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
  tag?: string;
  decade?: number;
  year?: number;
  minRating?: number;
  person?: string;
}

// ---- Block 17 D1: media traits (quality chips, browse filter 4K / HDR) -------------------------------------------------------
/**
 * What the video / audio of a title looks like (chips "4K", "HDR", "Dolby Vision", "Atmos" ...). Server-neutral summary of the best
 * video stream and the best audio stream; a series reports its best episode. Optional on the interface: an implementation without
 * stream details leaves `mediaTraits` / `libraryMediaTraits` out and the web simply shows no chips and no 4K / HDR filter.
 */
export interface MediaTraits {
  /** '4k' (>= 2160p class), 'hd' (>= 720p) or 'sd' */
  resolution: '4k' | 'hd' | 'sd';
  /** high dynamic range flavour of the video, null = SDR / unknown */
  hdr: 'dolbyvision' | 'hdr10plus' | 'hdr10' | 'hlg' | null;
  /** best audio layout, null = unknown */
  audio: 'atmos' | 'surround' | 'stereo' | 'mono' | null;
}
/** One library item (movie, or episode with its `seriesId`) with its traits: input of the quality index behind the browse filter. */
export interface ItemMediaTraits { id: string; seriesId?: string; traits: MediaTraits }

// ---- Block 17 P1: chapters + credits (player "Szenen" panel, "Besetzung & Infos") ----------------------------------------------
/** One chapter mark of a video. `start` in seconds; `name` may be '' (the web then says "Kapitel 3"); `image` = a still (gateway URL). */
export interface ChapterDto { start: number; name: string; image?: string }
/**
 * One credited person of an item. `type` keeps the vocabulary 'Actor' | 'GuestStar' | 'Director' | 'Writer' | 'Producer' | 'Composer' …
 * (an implementation maps its own roles onto it); `role` is the character name for actors / guest stars.
 */
export interface CreditDto { id: string; name: string; role?: string; type: string; image: boolean }
/** Credits plus the background facts an ItemDto does not carry. Episodes report their own credits (guest stars, director, writer). */
export interface ItemCreditsDto { people: CreditDto[]; studios: string[]; tags: string[] }

/** Metadata FriendFlix classifies on (e.g. "is this an anime"): genres, tags, production countries. */
export interface ItemTraits { genres: string[]; tags: string[]; countries: string[] }
export interface PersonDto { id: string; name: string; overview?: string; birthYear?: number; image: boolean }
export interface TrackList { audio: Array<{ language: string; title: string; isDefault: boolean }>; subtitles: Array<{ language: string; title: string }>; runtimeTicks?: number; type: string }
export interface Segment { type: string; start: number; end: number }
export interface SubtitleHit { id: string; name: string; provider: string; format?: string; downloads?: number; rating?: number }
/** Audio / subtitle languages of one library item (raw codes, normalised by the caller); `seriesId` for episodes. */
export interface ItemStreams { id?: string; seriesId?: string; audio: string[]; subtitles: string[] }
/** Playback the server reports that FriendFlix did not start (other apps): "Läuft gerade". */
export interface ExternalSession {
  sessionId: string; serverUserId: string; positionTicks: number; isPaused: boolean;
  item: { id: string; name: string; seriesName?: string; type?: string; runtimeTicks?: number };
}
/** What the gateway (and Plan B) needs to act as the user upstream. Never sent to browsers. */
export interface MediaCredentials { token: string; deviceId: string }
/** A FriendFlix player's progress report (positions in ticks, like everywhere else). */
export interface PlaybackReport {
  event: 'start' | 'progress' | 'stop';
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  positionTicks: number;
  paused: boolean;
  audioIndex?: number;
  subtitleIndex?: number;
  playMethod?: 'DirectPlay' | 'DirectStream' | 'Transcode';
}

/**
 * Neutral library / playback events. Sources: the Jellyfin webhook route (translated there) or an implementation's own change feed
 * (start()). media/events.ts dispatchMediaEvent() handles them (reminders, "now playing", user-data caches) and re-emits them on the
 * bus as 'media.event'.
 */
export type MediaEvent =
  | { type: 'itemAdded'; itemId: string; itemType: string; tmdbId?: number; seriesId?: string; season?: number; episode?: number }
  | { type: 'itemRemoved'; itemId: string; itemType?: string }
  | {
      type: 'playback'; state: 'start' | 'progress' | 'stop';
      /** the server identity that plays: by id (jellyfin_user_id column) or, for Jellyfin webhooks, by user name */
      serverUserId?: string; serverUserName?: string;
      itemId: string; name?: string; seriesName?: string; positionTicks?: number; runtimeTicks?: number; paused: boolean;
      /** stable per playing device/session (the live entry key) */
      device: string;
    };

/** What start() gets: a sink for change-feed events and a logger. */
export interface MediaRuntime {
  dispatch(e: MediaEvent): Promise<void>;
  log: { warn(o: unknown, msg?: string): void; info(o: unknown, msg?: string): void };
}
export interface PlaybackOptions { maxBitrate: number; maxHeight?: number | null; startTicks?: number; audioIndex?: number; audioLang?: string; cast?: boolean; noDirect?: boolean }
/** Server-side transcode of a short clip / probe (preview clips, playback health check): forced re-encode at these limits. */
export interface ClipTranscode { audioIndex?: number; fmp4?: boolean; videoBitrate: number; audioBitrate: number; maxWidth: number; stereo?: boolean; maxBitrate?: number }

/** Role/kids policy for one identity; the implementation maps it to the server's own access model. */
export interface IdentityPolicy {
  template: RoleTemplate;
  disabled: boolean;
  /** hide the identity from the server's own login screen (profile users) */
  hidden?: boolean;
  /** kids caps: maxRating overrides the template cap; blockUnrated = item types hidden when unrated ([] clears an old block) */
  parental?: { maxRating?: number; blockUnrated: string[] };
}

/** Admin-key side: identities (one per account / profile), policies, server health, foreign sessions. */
export interface MediaAdmin {
  createIdentity(name: string, password: string): Promise<{ id: string }>;
  /** Removes an identity; an unknown one counts as removed. Throws MediaError otherwise. */
  deleteIdentity(id: string): Promise<void>;
  applyPolicy(id: string, policy: IdentityPolicy): Promise<void>;
  setDisabled(id: string, disabled: boolean): Promise<void>;
  libraries(): Promise<Array<{ id: string; name: string }>>;
  ping(): Promise<boolean>;
  /** active playback not started through FriendFlix */
  externalSessions(): Promise<ExternalSession[]>;
}

/** Everything routes and jobs use. Per-user calls act as that user on the server, so its access rules apply. */
export interface MediaServer {
  readonly kind: string;
  readonly capabilities: MediaCapabilities;
  readonly admin: MediaAdmin;

  // ---- credentials / raw media
  mediaAuth(user: MediaUser): Promise<MediaCredentials>;
  /** Plan B: Authorization header nginx sends upstream (only when capabilities.planB). */
  planBAuthHeader(cred: MediaCredentials): string;
  /** Fetches a server-relative media URL (playlist / segment from a PlaybackDto, DownloadSourceDto or clipTranscode) as the user. */
  mediaFetch(user: MediaUser, path: string, init?: RequestInit): Promise<Response>;
  /** HLS master (server-relative, for mediaFetch) of a forced transcode based on a playbackInfo() answer; async so a decision call may precede it. */
  clipTranscode(user: MediaUser, info: PlaybackDto, o: ClipTranscode): Promise<{ path: string; playSessionId: string }>;
  /** Stops the server-side transcode behind a play session. Never throws. */
  stopEncoding(user: MediaUser, playSessionId: string): Promise<void>;

  // ---- browse
  views(user: MediaUser): Promise<ItemDto[]>;
  items(user: MediaUser, q: ItemQuery): Promise<{ items: ItemDto[]; total: number }>;
  item(user: MediaUser, id: string): Promise<ItemDto>;
  resume(user: MediaUser): Promise<ItemDto[]>;
  history(user: MediaUser, q?: { start?: number; limit?: number }): Promise<ItemDto[]>;
  nextUp(user: MediaUser, seriesId?: string): Promise<ItemDto[]>;
  nextEpisode(user: MediaUser, seriesId: string, episodeId: string): Promise<ItemDto | null>;
  seasons(user: MediaUser, seriesId: string): Promise<ItemDto[]>;
  episodes(user: MediaUser, seriesId: string, seasonId?: string): Promise<ItemDto[]>;
  firstEpisode(user: MediaUser, seriesId: string): Promise<{ id: string; runtimeTicks?: number } | null>;
  upcoming(user: MediaUser): Promise<ItemDto[]>;
  similar(user: MediaUser, id: string, limit?: number): Promise<ItemDto[]>;
  lastWatched(user: MediaUser): Promise<ItemDto | null>;
  unplayedIds(user: MediaUser, types: string, cap?: number): Promise<Set<string>>;
  collections(user: MediaUser): Promise<ItemDto[]>;
  genres(user: MediaUser, types?: string): Promise<string[]>;
  studios(user: MediaUser): Promise<string[]>;
  /** studios / genres with their title counts (hub suggestions); [] on failure */
  facets(user: MediaUser, kind: 'studio' | 'genre'): Promise<Array<{ name: string; count: number }>>;
  extras(user: MediaUser, id: string): Promise<ItemDto[]>;
  trailers(user: MediaUser, id: string): Promise<ItemDto[]>;
  trailer(user: MediaUser, id: string): Promise<string | null>;
  people(user: MediaUser, id: string): Promise<Array<{ id: string; name: string; role?: string; type: string; image: boolean }>>;
  searchPeople(user: MediaUser, q: string, limit?: number): Promise<Array<{ id: string; name: string; image: boolean }>>;
  /** null when `id` is not a person (or not visible) */
  person(user: MediaUser, id: string): Promise<PersonDto | null>;
  tracks(user: MediaUser, id: string): Promise<TrackList>;
  segments(user: MediaUser, id: string): Promise<Segment[]>;
  /** newest library items (movies + episodes), newest first */
  addedItems(user: MediaUser, page: { start: number; limit: number }): Promise<ItemDto[]>;
  itemTraits(user: MediaUser, id: string): Promise<ItemTraits | null>;
  /** continuing (still airing) series with their traits */
  continuingSeries(user: MediaUser): Promise<Array<{ item: ItemDto; traits: ItemTraits }>>;
  /** episodes premiering in [from, to], newest first (aired and announced) */
  premieringEpisodes(user: MediaUser, from: string, to: string): Promise<ItemDto[]>;
  /** the subset of `ids` that are real (not merely announced) episodes */
  availableEpisodes(user: MediaUser, ids: string[]): Promise<Set<string>>;
  /** episode number -> id of the real episodes of one season */
  seasonEpisodeIds(user: MediaUser, seriesId: string, season: number): Promise<Map<number, string>>;

  // ---- Block 17 D1 (optional): stream details. Absent = not supported (no quality chips / 4K + HDR filter).
  /** traits of one title the viewer can see (series: best episode); null when not visible or unknown */
  mediaTraits?(user: MediaUser, id: string): Promise<MediaTraits | null>;
  /** one page of the whole library's traits (admin key, quality index); a short page = the end */
  libraryMediaTraits?(type: 'Movie' | 'Episode', start: number, limit: number): Promise<ItemMediaTraits[]>;
  /**
   * one page of the ids of ALL continuing series (admin key, library-wide; fresh label "Staffelfinale" needs to know a series is NOT
   * continuing). Short page = the end. Absent = fresh.ts falls back to continuingSeries(viewer), cached per viewer.
   */
  libraryContinuingSeriesIds?(start: number, limit: number): Promise<string[]>;

  // ---- Block 17 P1 (optional): player depth. Absent = fallbacks (credits: people() + itemTraits(); chapters: none).
  /** chapter marks of a video the viewer can see, sorted by start ([] = none); only called when capabilities.chapters */
  chapters?(user: MediaUser, id: string): Promise<ChapterDto[]>;
  /** all credits (incl. guest stars) + studios + tags of an item the viewer can see ("Besetzung & Infos") */
  credits?(user: MediaUser, id: string): Promise<ItemCreditsDto>;

  // ---- user data
  forgetItems(serverUserId?: string): void;
  touchUserData(serverUserId: string): Promise<void>;
  userDataVersion(user: MediaUser): Promise<string>;
  setFavorite(user: MediaUser, id: string, on: boolean): Promise<void>;
  setPlayed(user: MediaUser, id: string, on: boolean): Promise<void>;
  setUserData(user: MediaUser, id: string, d: { positionTicks: number; played: boolean; lastPlayedDate: Date | string }): Promise<void>;

  // ---- playback
  playbackInfo(user: MediaUser, itemId: string, opts: PlaybackOptions): Promise<PlaybackDto>;
  /** resume position + trickplay for the media source playbackInfo picks (runs in parallel with it); null when the lookup fails */
  playMeta(user: MediaUser, itemId: string): Promise<{ positionTicks: number; trickplay: (mediaSourceId: string) => TrickplayDto | undefined } | null>;
  downloadSource(user: MediaUser, itemId: string, opts: { quality: DownloadQuality; audioIndex?: number; maxHeight?: number | null; maxBitrate?: number | null }): Promise<DownloadSourceDto>;
  /**
   * Optional step after playbackInfo() and before the client fetches the master playlist (player and Chromecast): e.g. a transcode
   * decision plus per-account audio/subtitle selection under a lock, returning a PlaybackDto with session-bound URLs. An implementation
   * may equally do this inside playbackInfo(). Jellyfin: not implemented (its HLS URL carries everything).
   */
  preparePlayback?(user: MediaUser, info: PlaybackDto, opts: PlaybackOptions): Promise<PlaybackDto>;
  report(user: MediaUser, r: PlaybackReport): Promise<void>;
  /** One text subtitle as WebVTT (see capabilities.subtitleExtract); a non-ok Response when unavailable. */
  subtitleStream(user: MediaUser, itemId: string, mediaSourceId: string, streamIndex: number, format: 'vtt'): Promise<Response>;

  /**
   * Translates a webhook body POSTed by the server to /internal/webhook/<kind> (secret-checked) into neutral events; null = malformed (400).
   * Absent: no webhook route for this kind.
   */
  webhookEvents?(body: unknown): MediaEvent[] | null;

  // ---- lifecycle (optional): change feeds, websockets, sync jobs. Called from server.ts startup / shutdown.
  start?(rt: MediaRuntime): Promise<void>;
  stop?(): Promise<void>;

  // ---- admin-key lookups (callers check item access first)
  searchSubtitles(id: string, lang: string): Promise<SubtitleHit[]>;
  downloadSubtitle(id: string, subtitleId: string): Promise<void>;
  findByTmdb(tmdbId: number, mediaType: string): Promise<{ id: string; name: string } | null>;
  /** a series has at least one real episode (library-wide) */
  seriesHasEpisode(seriesId: string): Promise<boolean>;
  /** one page of the whole library's stream languages (language index); a short page = the end */
  libraryStreams(type: 'Movie' | 'Episode', start: number, limit: number): Promise<ItemStreams[]>;
}
