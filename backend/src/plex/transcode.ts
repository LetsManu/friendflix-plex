// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Plex universal transcoder (HLS, MPEG-TS segments). Verified against PMS 1.43 (block16 spike):
 *  - X-Plex-Platform + X-Plex-Product are mandatory (else 400 "unable to find client profile"); Chrome -> "Web" profile
 *    (h264/aac copy when no limits are sent, mp3 audio when audio is converted), Android -> h264 + AAC (cast, downloads, clips).
 *  - start.m3u8 must follow a decision call with the same query and client identifier.
 *  - audioStreamID in the query is ignored: the audio track is ACCOUNT state (PUT /library/parts/<id>?audioStreamID=&allParts=1),
 *    snapshotted when the transcode starts. With one admin token, PUT -> decision -> start runs under a lock per item so concurrent
 *    starts with different tracks never mix.
 *  - index.m3u8 may 404 for a few seconds after start; stop: GET /video/:/transcode/universal/stop?session=<id>.
 * Never calls timeline/scrobble endpoints (they would write into the admin's Plex watch state).
 */
import { MediaError } from '../media/types.js';
import { sessionPath, TRANSCODE } from './mediapaths.js';
import { parseDecision, type PlexDecision } from './reason.js';

/** Server-relative request to Plex with the admin token + X-Plex identification headers. Resolves for any HTTP status. */
export interface PlexHttp {
  fetch(path: string, init?: RequestInit & { clientId?: string; platform?: TranscodePlatform }): Promise<Response>;
}

export type TranscodePlatform = 'Chrome' | 'Android';

/**
 * PlexHttp over the core client (client.ts PlexClient.fetch: admin token + X-Plex headers, server-relative paths only).
 * clientId / platform become the X-Plex-Client-Identifier / X-Plex-Platform headers of that one request.
 */
export function plexHttpFromClient(client: { fetch(path: string, init?: RequestInit): Promise<Response> }): PlexHttp {
  return {
    fetch(path, init = {}) {
      const { clientId, platform, ...rest } = init;
      const headers: Record<string, string> = {};
      new Headers(rest.headers).forEach((v, k) => (headers[k] = v));
      if (clientId) headers['X-Plex-Client-Identifier'] = clientId;
      if (platform) headers['X-Plex-Platform'] = platform;
      return client.fetch(path, { ...rest, headers, redirect: 'manual' });
    },
  };
}

/** Promise-chain mutex per key (one backend process; the transcoder snapshot is per part/account). */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => next);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
  get size() { return this.tails.size; }
}

export interface TranscodeParams {
  /** Plex ratingKey of the movie / episode / clip */
  ratingKey: string;
  session: string;
  platform: TranscodePlatform;
  /** kbps; omitted = no limit (Web profile then stream-copies compatible sources) */
  maxVideoBitrate?: number;
  /** WxH bounding box, only sent when the source exceeds the height cap or the bitrate rung's height (rungHeight) */
  videoResolution?: string;
  /** false forces re-encoding (preview clips, health check) */
  directStream: boolean;
}

export function transcodeQuery(p: TranscodeParams): URLSearchParams {
  const q = new URLSearchParams({
    path: `/library/metadata/${p.ratingKey}`, mediaIndex: '0', partIndex: '0', protocol: 'hls', directPlay: '0', directStream: p.directStream ? '1' : '0',
    fastSeek: '1', subtitles: 'none', session: p.session, 'X-Plex-Client-Identifier': p.session, 'X-Plex-Product': 'FriendFlix',
    'X-Plex-Platform': p.platform, 'X-Plex-Device': 'FriendFlix', 'X-Plex-Version': '1',
  });
  if (p.maxVideoBitrate) q.set('maxVideoBitrate', String(Math.max(64, Math.round(p.maxVideoBitrate))));
  if (p.videoResolution) q.set('videoResolution', p.videoResolution);
  return q;
}

/** 16:9 bounding box for a height cap */
export const resolutionFor = (height: number) => `${Math.round((height * 16) / 9 / 2) * 2}x${height}`;

/**
 * Output height for a converted stream at this total bitrate (bit/s), same rungs as upstream's Jellyfin transcode URL: a 4K source
 * converted at 8 Mbit/s comes out as 1080p, not as a 4K picture starved of bits or whatever size Plex picks on its own.
 */
export const rungHeight = (bps: number) => (bps >= 8e6 ? 1080 : bps >= 4e6 ? 720 : bps >= 1.5e6 ? 480 : 360);

export interface AudioSelection { partKey: string; audioStreamId?: string }

/**
 * PUT selection -> decision -> start.m3u8, serialized per ratingKey. Throws MediaError when Plex refuses (bad request, no
 * playable conversion). Returns the decision code and the per-stream decisions (copy / transcode, for PlaybackDto.transcodeReason).
 */
export async function startTranscode(http: PlexHttp, lock: KeyedMutex, p: TranscodeParams, sel: AudioSelection): Promise<{ decision: number; streams: PlexDecision }> {
  const q = transcodeQuery(p);
  return lock.run(`rk:${p.ratingKey}`, async () => {
    if (sel.audioStreamId) {
      const put = await http.fetch(`/library/parts/${sel.partKey}?${new URLSearchParams({ audioStreamID: sel.audioStreamId, allParts: '1' })}`, { method: 'PUT', clientId: p.session, platform: p.platform });
      if (!put.ok) throw new MediaError(502, `plex: audio selection -> ${put.status}`);
      await put.arrayBuffer().catch(() => undefined);
    }
    const d = await http.fetch(`${TRANSCODE}/decision?${q}`, { clientId: p.session, platform: p.platform });
    if (!d.ok) throw new MediaError(d.status === 404 ? 404 : 502, `plex: decision -> ${d.status}`);
    const dj = (await d.json().catch(() => null)) as { MediaContainer?: Record<string, unknown> } | null;
    const code = Number(dj?.MediaContainer?.generalDecisionCode ?? 0);
    if (code >= 2000) throw new MediaError(415, `plex: no playable stream (${code})`);
    const s = await http.fetch(`${TRANSCODE}/start.m3u8?${q}`, { clientId: p.session, platform: p.platform, headers: { accept: '*/*' } });
    if (!s.ok) throw new MediaError(502, `plex: start -> ${s.status}`);
    await s.arrayBuffer().catch(() => undefined); // the master only names session/<s>/base/index.m3u8
    return { decision: code, streams: parseDecision(dj) };
  });
}

/** Polls the session playlist until the transcoder produced it (404 for a few seconds after start). */
export async function waitForIndex(http: PlexHttp, session: string, opts: { timeoutMs?: number; stepMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<string> {
  const timeout = opts.timeoutMs ?? 20_000;
  const step = opts.stepMs ?? 400;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = Date.now();
  for (let n = 0; ; n++) {
    const r = await http.fetch(sessionPath(session, 'index.m3u8'), { clientId: session, headers: { accept: '*/*' } });
    if (r.ok) {
      const text = await r.text();
      if (/\.ts\s*$/m.test(text)) return text;
    } else {
      await r.arrayBuffer().catch(() => undefined);
      if (r.status !== 404) throw new MediaError(502, `plex: session playlist -> ${r.status}`);
    }
    if (Date.now() - t0 >= timeout) throw new MediaError(504, 'plex: transcoder did not start');
    await sleep(Math.min(step * (n + 1), 1500));
  }
}

/** Stops a transcode session. Never throws. */
export async function stopTranscode(http: PlexHttp, session: string): Promise<void> {
  try {
    const r = await http.fetch(`${TRANSCODE}/stop?${new URLSearchParams({ session })}`, { clientId: session });
    await r.arrayBuffer().catch(() => undefined);
  } catch {
    /* best effort */
  }
}
