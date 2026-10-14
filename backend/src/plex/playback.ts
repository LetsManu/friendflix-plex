// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Playback on Plex (MediaServer playback/credential methods). PlexMediaServer (service.ts) delegates to one PlexPlayback instance.
 *
 *  playbackInfo   access check (deps.item), Plex metadata of the item, tracks, direct-play eligibility, a fresh item-bound session
 *                 (registry kv plexsess:<session>); nothing is started yet.
 *  preparePlayback  PUT audio selection -> decision -> start under a per-item lock, waits for the session playlist (HLS only).
 *  clipTranscode / downloadSource  own sessions; fMP4 consumers get a virtual remuxed playlist (./downloads.ts) via mediaFetch.
 *  stopEncoding   GET /video/:/transcode/universal/stop for sessions of this identity (report()'s 'stop' should call it too).
 * mediaAuth / planBAuthHeader / report (user data only, never Plex timeline/scrobble) live in the core service.
 * Index numbers in PlaybackDto/DownloadSourceDto (audio, subtitles) are positions in the part's Plex Stream[] array.
 */
import type { KV } from '../kv.js';
import {
  MediaError, type ClipTranscode, type DownloadQuality, type DownloadSourceDto, type ItemDto, type MediaUser,
  type PlaybackDto, type PlaybackOptions, type TrickplayDto, DOWNLOAD_PRESETS,
} from '../media/types.js';
import { encodePlexId, plexKey } from './ids.js';
import { directUrl, hlsUrl, SESSION_FILE_RE, sessionFor, sessionPath, subtitleUrl, verifySession } from './mediapaths.js';
import { fmp4Playlist, spawnFfmpeg, splitFmp4, TS_TO_FMP4_ARGS, VIRTUAL_RE, virtualMaster, type PlexFfmpeg } from './downloads.js';
import { extractEmbedded, sidecarToVtt, TEXT_SUB_CODECS, VttCache } from './subtitles.js';
import { BifLookup, trickplayDto } from './trickplay.js';
import { KeyedMutex, plexHttpFromClient, resolutionFor, rungHeight, startTranscode, stopTranscode, waitForIndex, type PlexHttp, type TranscodePlatform } from './transcode.js';
import { BROWSER_CONTAINER, DIRECT_AUDIO, DIRECT_VIDEO, plexTranscodeReason, type PlexDecision, type ReasonFacts } from './reason.js';

// ---------------------------------------------------------------- Plex shapes (lenient: numbers are sometimes strings)

export interface PlexStream {
  id: number | string; streamType: number | string; codec?: string; index?: number | string; key?: string;
  language?: string; languageCode?: string; languageTag?: string; title?: string; displayTitle?: string;
  default?: boolean | string | number; selected?: boolean | string | number; bitDepth?: number | string; width?: number | string; height?: number | string;
}
export interface PlexPart { id: number | string; key?: string; size?: number | string; container?: string; duration?: number | string; indexes?: string; Stream?: PlexStream[] }
export interface PlexMedia { id?: number | string; bitrate?: number | string; width?: number | string; height?: number | string; container?: string; videoCodec?: string; audioCodec?: string; duration?: number | string; Part?: PlexPart[] }
export interface PlexMetadata { ratingKey: number | string; type?: string; duration?: number | string; updatedAt?: number | string; Media?: PlexMedia[] }

/** What PlexPlayback needs from the core implementation (client + access check). */
export interface PlexPlaybackDeps {
  http: PlexHttp;
  kv: KV;
  /** INTERNAL_SECRET: signs item-bound media URLs / sessions (verified by the gateway with the same secret) */
  secret: string;
  /** visibility-checked item (MediaServer.item): throws MediaError 404/403 when the identity may not see it */
  item(user: MediaUser, id: string): Promise<ItemDto>;
  ffmpeg?: PlexFfmpeg;
  sleep?: (ms: number) => Promise<void>;
  /** max wait for the first segment after a start (default 20 s) */
  indexTimeoutMs?: number;
  log?: { warn(o: unknown, msg?: string): void };
}

interface SessionRec {
  owner: string;
  itemId: string;
  rk: string;
  part: string;
  /** Plex stream id of the wanted audio track (undefined = leave the account selection alone: single track) */
  audio?: string;
  platform: TranscodePlatform;
  maxKbps?: number;
  res?: string;
  directStream: boolean;
  started: boolean;
  stopped?: boolean;
  /** player sessions that may be converted: what the transcode reason is derived from once Plex has decided */
  why?: ReasonFacts;
}

const SESS_TTL = 24 * 3600;
const META_TTL_MS = 10_000;

const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
const yes = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';
const lc = (v: unknown) => String(v ?? '').toLowerCase();
const ownerOf = (u: MediaUser) => `${u.id}|${u.jellyfin_user_id}`;
const bytes = (b: Uint8Array) => new Uint8Array(b);

/** ISO 639-2 B/T pairs so a saved 'ger' preference matches Plex' 'deu' (and the other way round). */
const LANG_ALIASES: Record<string, string> = {
  ger: 'deu', deu: 'ger', fre: 'fra', fra: 'fre', chi: 'zho', zho: 'chi', dut: 'nld', nld: 'dut', cze: 'ces', ces: 'cze', gre: 'ell', ell: 'gre',
  per: 'fas', fas: 'per', rum: 'ron', ron: 'rum', slo: 'slk', slk: 'slo', alb: 'sqi', sqi: 'alb', arm: 'hye', hye: 'arm', baq: 'eus', eus: 'baq',
  bur: 'mya', mya: 'bur', geo: 'kat', kat: 'geo', ice: 'isl', isl: 'ice', mac: 'mkd', mkd: 'mac', mao: 'mri', mri: 'mao', may: 'msa', msa: 'may',
  tib: 'bod', bod: 'tib', wel: 'cym', cym: 'wel',
};
export const langMatches = (s: PlexStream, want: string) => {
  const w = want.toLowerCase();
  const codes = [lc(s.languageCode), lc(s.languageTag)].filter(Boolean);
  return codes.includes(w) || (LANG_ALIASES[w] !== undefined && codes.includes(LANG_ALIASES[w]!));
};

interface Resolved {
  rk: string;
  item: ItemDto;
  meta: PlexMetadata;
  media: PlexMedia;
  part: PlexPart;
  partKey: string;
  /** id32 of the part (= mediaSourceId) */
  partId: string;
  streams: PlexStream[];
}

export class PlexPlayback {
  readonly lock = new KeyedMutex();
  private readonly metaMemo = new Map<string, { exp: number; p: Promise<PlexMetadata> }>();
  private readonly bifs: BifLookup;
  private readonly vtt = new VttCache();
  private readonly remuxed = new Map<string, { exp: number; p: Promise<{ init: Buffer; media: Buffer }> }>();
  private readonly ff: PlexFfmpeg;

  constructor(private readonly d: PlexPlaybackDeps) {
    this.bifs = new BifLookup(d.http);
    this.ff = d.ffmpeg ?? spawnFfmpeg;
  }

  // ---------------------------------------------------------------- credentials / raw media

  /**
   * Server-relative media for backend jobs: files of a transcode session this identity owns and the virtual fMP4/TS playlists of
   * ./downloads.ts. Anything else is refused (403 response); absolute URLs throw.
   */
  async mediaFetch(user: MediaUser, path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /^[a-z][\w+.-]*:/i.test(path)) throw new MediaError(400, 'mediaFetch: server-relative paths only');
    const [p] = path.split('?') as [string];
    const v = VIRTUAL_RE.exec(p);
    if (v) return this.virtual(user, v[1] as 'fmp4' | 'hls', v[2]!, v[3]!);
    const s = SESSION_FILE_RE.exec(p);
    if (!s) return new Response('forbidden', { status: 403 });
    const rec = await this.owned(user, s[1]!);
    if (!rec) return new Response('not found', { status: 404 });
    if (s[2] === 'index.m3u8') {
      await this.ensureStarted(s[1]!, rec, false);
      return new Response(await waitForIndex(this.d.http, s[1]!, this.waitOpts()), { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
    }
    return this.segment(s[1]!, rec, Number(s[2]!.slice(0, -3)), init);
  }

  /** Forced re-encode of a playbackInfo() item at the given limits (preview clips, health check). Starts it and waits for the first segment. */
  async clipTranscode(user: MediaUser, info: PlaybackDto, o: ClipTranscode): Promise<{ path: string; playSessionId: string }> {
    const base = await this.owned(user, info.playSessionId);
    if (!base) throw new MediaError(404, 'clipTranscode: unknown play session');
    const r = await this.resolve(user, base.itemId);
    const session = sessionFor(this.d.secret, base.itemId);
    const audio = o.audioIndex !== undefined ? this.audioId(r.streams, o.audioIndex) : undefined;
    const h = Math.round((o.maxWidth * 9) / 16 / 2) * 2;
    const rec: SessionRec = {
      owner: ownerOf(user), itemId: base.itemId, rk: r.rk, part: r.partKey, audio: audio ?? this.defaultAudio(r.streams), platform: 'Android',
      maxKbps: Math.max(64, Math.round(o.videoBitrate / 1000)), res: `${o.maxWidth}x${h}`, directStream: false, started: false,
    };
    await this.save(session, rec);
    await this.ensureStarted(session, rec);
    return { path: virtualMaster(o.fmp4 ? 'fmp4' : 'hls', session), playSessionId: session };
  }

  /** Stops the Plex transcode behind a session this identity owns. Never throws. */
  async stopEncoding(user: MediaUser, playSessionId: string): Promise<void> {
    try {
      const rec = await this.owned(user, playSessionId);
      if (!rec) return;
      await stopTranscode(this.d.http, playSessionId);
      await this.save(playSessionId, { ...rec, started: false, stopped: true });
    } catch {
      /* never throws */
    }
  }

  // ---------------------------------------------------------------- playback

  async playbackInfo(user: MediaUser, itemId: string, opts: PlaybackOptions): Promise<PlaybackDto> {
    const r = await this.resolve(user, itemId);
    const audioTracks = this.audioTracks(r.streams);
    let audioIndex = opts.audioIndex !== undefined && audioTracks.some((a) => a.index === opts.audioIndex) ? opts.audioIndex : undefined;
    if (audioIndex === undefined && opts.audioLang) {
      const want = audioTracks.find((a) => langMatches(r.streams[a.index]!, opts.audioLang!));
      if (want && !want.isDefault) audioIndex = want.index;
    }
    const cast = Boolean(opts.cast);
    const srcBps = (num(r.media.bitrate) ?? 0) * 1000;
    const height = num(r.media.height) ?? num(r.streams.find((s) => Number(s.streamType) === 1)?.height) ?? 0;
    const withinCap = !opts.maxHeight || (height > 0 && height <= opts.maxHeight);
    const video = r.streams.find((s) => Number(s.streamType) === 1);
    const container = String(r.media.container ?? r.part.container ?? '');
    const bitDepth = num(video?.bitDepth) ?? 8;
    const videoOk = DIRECT_VIDEO.has(lc(r.media.videoCodec)) && bitDepth <= 8;
    const directOk = !cast && !opts.noDirect && audioIndex === undefined && withinCap && srcBps > 0 && srcBps <= opts.maxBitrate &&
      BROWSER_CONTAINER.test(container) && videoOk && DIRECT_AUDIO.has(lc(r.media.audioCodec));
    const playing = audioIndex !== undefined ? r.streams[audioIndex] : r.streams[(audioTracks.find((a) => a.isDefault) ?? audioTracks[0])?.index ?? -1];
    const why: ReasonFacts | undefined = directOk ? undefined : {
      container, videoCodec: lc(r.media.videoCodec || video?.codec), bitDepth, audioCodec: lc(playing?.codec || r.media.audioCodec),
      srcBps, srcHeight: height, maxBitrate: opts.maxBitrate, maxHeight: opts.maxHeight, audioIndex, capReason: opts.capReason,
    };
    // The Web profile stream-copies compatible sources only without a bitrate limit: send one when the source exceeds the cap, its
    // bitrate is unknown, the video has to be converted anyway, or for cast. A converted stream also gets the rung's height (and the
    // role's height cap), so a 4K source comes out at the chosen quality instead of a size Plex picks itself.
    const limit = cast || srcBps === 0 || srcBps > opts.maxBitrate || !videoOk;
    const boxH = Math.min(limit ? rungHeight(opts.maxBitrate) : Infinity, opts.maxHeight || Infinity);

    const session = sessionFor(this.d.secret, itemId);
    const rec: SessionRec = {
      owner: ownerOf(user), itemId, rk: r.rk, part: r.partKey,
      audio: audioIndex !== undefined ? this.audioId(r.streams, audioIndex) : this.defaultAudio(r.streams),
      platform: cast ? 'Android' : 'Chrome',
      maxKbps: limit ? Math.max(300, Math.round(opts.maxBitrate / 1000) - 192) : undefined,
      res: Number.isFinite(boxH) && (!height || height > boxH) ? resolutionFor(boxH) : undefined,
      directStream: true, started: false, why,
    };
    await this.save(session, rec);
    return {
      itemId,
      playSessionId: session,
      mediaSourceId: r.partId,
      directUrl: directOk ? directUrl(this.d.secret, itemId, r.partId) : undefined,
      hlsUrl: hlsUrl(itemId, session),
      runtimeTicks: this.runtimeTicks(r),
      resumeTicks: opts.startTicks ?? 0,
      maxBitrate: opts.maxBitrate,
      // first guess from the source; preparePlayback() refines it with Plex' stream decisions
      ...(why ? { transcodeReason: plexTranscodeReason(why) } : {}),
      ...(audioIndex !== undefined ? { audioIndex } : {}),
      audioTracks,
      // also for cast: the cast route turns these /api URLs into signed /api/cast/subtitle URLs (capabilities.subtitleExtract)
      subtitles: this.textSubs(r.streams).map((t) => ({ ...t, url: subtitleUrl(itemId, r.partId, t.index) })),
    };
  }

  /** Starts the transcode for the session of `info` (audio selection under the lock) and waits for its playlist unless direct play is offered. */
  async preparePlayback(user: MediaUser, info: PlaybackDto, _opts: PlaybackOptions): Promise<PlaybackDto> {
    const rec = await this.owned(user, info.playSessionId);
    if (!rec || rec.itemId !== info.itemId) throw new MediaError(404, 'preparePlayback: unknown play session');
    // the player plays directUrl first (it re-requests playback info when it falls back to HLS): no need to wait for the transcoder then;
    // the client's own index.m3u8 request launches it
    const decided = await this.ensureStarted(info.playSessionId, rec, !info.directUrl);
    if (!info.directUrl && rec.why) info.transcodeReason = plexTranscodeReason(rec.why, decided);
    return info;
  }

  async playMeta(user: MediaUser, itemId: string): Promise<{ positionTicks: number; trickplay: (mediaSourceId: string) => TrickplayDto | undefined } | null> {
    try {
      const r = await this.resolve(user, itemId);
      const bif = String(r.part.indexes ?? '').split(',').includes('sd') ? await this.bifs.get(r.partKey) : null;
      const v = r.streams.find((s) => Number(s.streamType) === 1);
      const dims = { width: num(r.media.width) ?? num(v?.width), height: num(r.media.height) ?? num(v?.height) };
      return {
        positionTicks: r.item.positionTicks ?? 0,
        trickplay: (ms) => (bif && ms === r.partId ? trickplayDto(this.d.secret, itemId, r.partId, bif, dims) : undefined),
      };
    } catch {
      return null;
    }
  }

  async downloadSource(user: MediaUser, itemId: string, opts: { quality: DownloadQuality; audioIndex?: number; maxHeight?: number | null; maxBitrate?: number | null }): Promise<DownloadSourceDto> {
    const r = await this.resolve(user, itemId);
    const audio = this.audioTracks(r.streams);
    const def = audio.find((a) => a.isDefault) ?? audio[0];
    const defStream = def ? r.streams[def.index] : undefined;
    const video = r.streams.find((s) => Number(s.streamType) === 1);
    const height = num(r.media.height) ?? num(video?.height) ?? 0;
    const srcBps = (num(r.media.bitrate) ?? 0) * 1000;
    const size = num(r.part.size) ?? 0;
    const originalEligible =
      /(^|,)(mp4|m4v)(,|$)/i.test(String(r.media.container ?? r.part.container ?? '')) && lc(r.media.videoCodec || video?.codec) === 'h264' &&
      (num(video?.bitDepth) ?? 8) <= 8 && Boolean(defStream) && ['aac', 'mp3'].includes(lc(defStream?.codec)) &&
      (opts.audioIndex === undefined || opts.audioIndex === def?.index) &&
      (!opts.maxHeight || (height > 0 && height <= opts.maxHeight)) &&
      (!opts.maxBitrate || (srcBps > 0 && srcBps <= opts.maxBitrate)) && size > 0;
    const runtimeTicks = this.runtimeTicks(r);
    const preset = opts.quality === 'original' ? undefined : DOWNLOAD_PRESETS[opts.quality];
    const audioBps = preset?.audioBps ?? 128_000;
    const totalBps = opts.maxBitrate ?? (preset ? preset.videoBps + preset.audioBps : 0);
    const session = sessionFor(this.d.secret, itemId);
    let masterPath: string | undefined;
    if (preset) {
      const h = opts.maxHeight ?? preset.height;
      const audioId = opts.audioIndex !== undefined ? this.audioId(r.streams, opts.audioIndex) : this.defaultAudio(r.streams);
      await this.save(session, {
        owner: ownerOf(user), itemId, rk: r.rk, part: r.partKey, audio: audioId, platform: 'Android',
        maxKbps: Math.max(200, Math.round((totalBps - audioBps) / 1000)), res: !height || height > h ? resolutionFor(h) : undefined, directStream: false, started: false,
      });
      masterPath = virtualMaster('fmp4', session);
    }
    return {
      mediaSourceId: r.partId,
      originalEligible,
      sizeBytes: opts.quality === 'original' ? size : Math.round((((runtimeTicks ?? 0) / 1e7) * totalBps) / 8),
      runtimeTicks,
      playSessionId: session,
      audio: audio.map((a) => ({ index: a.index, lang: a.language ?? 'und', title: a.title, isDefault: a.isDefault })),
      subtitles: this.textSubs(r.streams).map((t) => ({ index: t.index, lang: t.language ?? 'und', title: t.title, url: subtitleUrl(itemId, r.partId, t.index) })),
      masterPath,
    };
  }

  async subtitleStream(user: MediaUser, itemId: string, mediaSourceId: string, streamIndex: number, format: 'vtt'): Promise<Response> {
    if (format !== 'vtt') return new Response('unsupported', { status: 400 });
    const r = await this.resolve(user, itemId);
    if (mediaSourceId !== r.partId) return new Response('not found', { status: 404 });
    const s = r.streams[streamIndex];
    if (!s || Number(s.streamType) !== 3 || !TEXT_SUB_CODECS.has(lc(s.codec))) return new Response('not found', { status: 404 });
    const key = `${r.partKey}|${s.id}|${r.meta.updatedAt ?? ''}`;
    try {
      const body = await this.vtt.get(key, async () => {
        if (s.key) {
          if (!/^\/library\/streams\/\d+$/.test(s.key)) throw new Error('unexpected stream key');
          const res = await this.d.http.fetch(s.key, { headers: { accept: '*/*' } });
          if (!res.ok) throw new Error(`sidecar ${res.status}`);
          return sidecarToVtt(this.ff, lc(s.codec), Buffer.from(await res.arrayBuffer()));
        }
        const idx = num(s.index);
        if (idx === undefined || !Number.isInteger(idx) || idx < 0) throw new Error('no container index');
        return extractEmbedded(this.d.http, this.ff, r.partKey, idx);
      });
      return new Response(bytes(body), { headers: { 'content-type': 'text/vtt; charset=utf-8' } });
    } catch (e) {
      this.d.log?.warn({ err: String(e), itemId }, 'plex subtitle conversion failed');
      return new Response('unavailable', { status: 502 });
    }
  }

  // ---------------------------------------------------------------- internals

  private waitOpts() {
    return { timeoutMs: this.d.indexTimeoutMs, sleep: this.d.sleep };
  }

  private async resolve(user: MediaUser, itemId: string): Promise<Resolved> {
    const rk = plexKey(itemId, 'item');
    if (!rk) throw new MediaError(404, 'not a Plex item id');
    const item = await this.d.item(user, itemId); // visibility (sections, age caps, kids) is enforced by the core
    const meta = await this.meta(rk);
    const media = meta.Media?.[0];
    const part = media?.Part?.[0];
    if (!media || !part || part.id === undefined) throw new MediaError(404, 'item has no playable media');
    const partKey = String(part.id);
    if (!/^\d{1,18}$/.test(partKey)) throw new MediaError(502, 'unexpected part id');
    return { rk, item, meta, media, part, partKey, partId: encodePlexId('part', partKey), streams: Array.isArray(part.Stream) ? part.Stream : [] };
  }

  private meta(rk: string): Promise<PlexMetadata> {
    const hit = this.metaMemo.get(rk);
    if (hit && hit.exp > Date.now()) return hit.p;
    const p = (async () => {
      const res = await this.d.http.fetch(`/library/metadata/${rk}`);
      if (!res.ok) throw new MediaError(res.status === 404 ? 404 : 502, `plex metadata -> ${res.status}`);
      const j = (await res.json()) as { MediaContainer?: { Metadata?: PlexMetadata[] } };
      const m = j.MediaContainer?.Metadata?.[0];
      if (!m) throw new MediaError(404, 'plex metadata: empty');
      return m;
    })();
    this.metaMemo.set(rk, { exp: Date.now() + META_TTL_MS, p });
    p.catch(() => this.metaMemo.delete(rk));
    if (this.metaMemo.size > 500) this.metaMemo.delete(this.metaMemo.keys().next().value!);
    return p;
  }

  private runtimeTicks(r: Resolved) {
    const ms = num(r.meta.duration) ?? num(r.media.duration) ?? num(r.part.duration);
    return ms ? Math.round(ms * 10_000) : r.item.runtimeTicks;
  }

  private audioTracks(streams: PlexStream[]) {
    const list = streams.map((s, i) => ({ s, i })).filter(({ s }) => Number(s.streamType) === 2);
    const hasDefault = list.some(({ s }) => yes(s.default));
    return list.map(({ s, i }, n) => ({
      index: i,
      language: s.languageCode || s.languageTag || undefined,
      title: s.displayTitle || s.title || s.language || `Spur ${i}`,
      isDefault: hasDefault ? yes(s.default) : n === 0,
    }));
  }

  private textSubs(streams: PlexStream[]) {
    return streams.map((s, i) => ({ s, i })).filter(({ s }) => Number(s.streamType) === 3 && TEXT_SUB_CODECS.has(lc(s.codec))).map(({ s, i }) => ({
      index: i, language: s.languageCode || s.languageTag || undefined, title: s.displayTitle || s.title || s.language || `Untertitel ${i}`, isDefault: yes(s.default),
    }));
  }

  /** Plex stream id of the audio track at array position `index` */
  private audioId(streams: PlexStream[], index: number): string | undefined {
    const s = streams[index];
    return s && Number(s.streamType) === 2 ? String(s.id) : undefined;
  }

  /** The file's default track when there is a choice: the account-wide selection may have been flipped by an earlier session. */
  private defaultAudio(streams: PlexStream[]): string | undefined {
    const audio = this.audioTracks(streams);
    if (audio.length < 2) return undefined;
    return this.audioId(streams, (audio.find((a) => a.isDefault) ?? audio[0]!).index);
  }

  private async save(session: string, rec: SessionRec) {
    await this.d.kv.set(`plexsess:${session}`, JSON.stringify(rec), SESS_TTL);
  }

  /** The session record when it exists, is bound to its item (HMAC) and belongs to this identity. */
  private async owned(user: MediaUser, session: string): Promise<SessionRec | null> {
    if (typeof session !== 'string' || !/^[0-9a-f]{16}-[0-9a-f]{24}$/.test(session)) return null;
    const raw = await this.d.kv.get(`plexsess:${session}`);
    if (!raw) return null;
    let rec: SessionRec;
    try {
      rec = JSON.parse(raw) as SessionRec;
    } catch {
      return null;
    }
    if (rec.owner !== ownerOf(user) || !verifySession(this.d.secret, rec.itemId, session)) return null;
    return rec;
  }

  /**
   * Starts the transcode if needed. Plex launches the transcoder only once the session playlist is requested (segments 404 before),
   * so `wait` also fetches index.m3u8 until it lists segments.
   */
  private async ensureStarted(session: string, rec: SessionRec, wait = true): Promise<PlexDecision | undefined> {
    let decided: PlexDecision | undefined;
    if (!rec.started) {
      decided = (await startTranscode(this.d.http, this.lock, {
        ratingKey: rec.rk, session, platform: rec.platform, maxVideoBitrate: rec.maxKbps, videoResolution: rec.res, directStream: rec.directStream,
      }, { partKey: rec.part, audioStreamId: rec.audio })).streams;
      rec.started = true;
      rec.stopped = false;
      await this.save(session, rec);
    }
    if (wait) await waitForIndex(this.d.http, session, this.waitOpts());
    return decided;
  }

  /** One Plex TS segment; a stopped / expired session is restarted (Plex seeks to the requested segment). */
  private async segment(session: string, rec: SessionRec, n: number, init: RequestInit = {}): Promise<Response> {
    const path = sessionPath(session, `${String(n).padStart(5, '0')}.ts`);
    await this.ensureStarted(session, rec, !rec.started);
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let restarted = false;
    for (let attempt = 0; ; attempt++) {
      const res = await this.d.http.fetch(path, { ...init, clientId: session, headers: { ...(init.headers as Record<string, string> | undefined), accept: '*/*' } });
      if (res.status !== 404 || attempt >= 8) return res;
      await res.arrayBuffer().catch(() => undefined);
      // not produced yet (Plex answers 404, it does not block) or the session is gone (stopped / reaped): only the latter restarts
      const idx = await this.d.http.fetch(sessionPath(session, 'index.m3u8'), { clientId: session, headers: { accept: '*/*' } });
      await idx.arrayBuffer().catch(() => undefined);
      if (idx.status === 404 && !restarted) {
        restarted = true;
        rec.started = false;
        await this.ensureStarted(session, rec);
        continue;
      }
      await sleep(Math.min(500 * (attempt + 1), 2000));
    }
  }

  private remux(session: string, rec: SessionRec, n: number): Promise<{ init: Buffer; media: Buffer }> {
    const key = `${session}|${n}`;
    const hit = this.remuxed.get(key);
    if (hit && hit.exp > Date.now()) return hit.p;
    const p = (async () => {
      const res = await this.segment(session, rec, n);
      if (!res.ok) throw new MediaError(res.status === 404 ? 404 : 502, `plex segment ${n} -> ${res.status}`);
      return splitFmp4(await this.ff.run([...TS_TO_FMP4_ARGS], Buffer.from(await res.arrayBuffer())));
    })();
    // only the first segment is reused (init.mp4 and 0.m4s); keep the map tiny
    if (n === 0) {
      this.remuxed.set(key, { exp: Date.now() + 600_000, p });
      p.catch(() => this.remuxed.delete(key));
      if (this.remuxed.size > 64) this.remuxed.delete(this.remuxed.keys().next().value!);
    }
    return p;
  }

  private async virtual(user: MediaUser, kind: 'fmp4' | 'hls', session: string, file: string): Promise<Response> {
    const rec = await this.owned(user, session);
    if (!rec) return new Response('not found', { status: 404 });
    const m3u8 = (t: string) => new Response(t, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
    const bw = (rec.maxKbps ?? 2000) * 1000 + 192_000;
    if (kind === 'hls') {
      if (file !== 'master.m3u8') return new Response('not found', { status: 404 });
      return m3u8(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=${bw}\n${sessionPath(session, 'index.m3u8')}\n`);
    }
    if (file === 'master.m3u8') return m3u8(`#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=${bw}\nmedia.m3u8\n`);
    if (file === 'media.m3u8') {
      await this.ensureStarted(session, rec, false);
      return m3u8(fmp4Playlist(await waitForIndex(this.d.http, session, this.waitOpts())).text);
    }
    try {
      if (file === 'init.mp4') return new Response(bytes((await this.remux(session, rec, 0)).init), { headers: { 'content-type': 'video/mp4' } });
      const n = Number(file.slice(0, -4));
      return new Response(bytes((await this.remux(session, rec, n)).media), { headers: { 'content-type': 'video/iso.segment' } });
    } catch (e) {
      const status = e instanceof MediaError ? e.status : 502;
      return new Response('segment unavailable', { status });
    }
  }
}

/**
 * Factory for PlexDeps.playback (service.ts): `playback: plexPlaybackFactory({ kv, secret: cfg.INTERNAL_SECRET })`.
 * Uses the service's client (admin token) and its visibility-checked item().
 */
export function plexPlaybackFactory(o: { kv: KV; secret: string } & Pick<PlexPlaybackDeps, 'ffmpeg' | 'log' | 'sleep' | 'indexTimeoutMs'>) {
  return (svc: { client: { fetch(path: string, init?: RequestInit): Promise<Response> }; item(user: MediaUser, id: string): Promise<ItemDto> }): PlexPlayback =>
    new PlexPlayback({ ...o, http: plexHttpFromClient(svc.client), item: (u, id) => svc.item(u, id) });
}
