// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Text subtitles as WebVTT (capabilities.subtitleExtract; served at /api/items/:id/subtitle/:ms/:index/stream.vtt).
 * Plex cannot do this itself (spike): sidecar files come from /library/streams/<id> as raw SRT labelled text/html (no conversion,
 * ?format=vtt ignored), embedded streams answer 501. So: sidecar SRT -> VTT in TypeScript, other sidecar formats and every embedded
 * text stream through ffmpeg. ffmpeg reads the media part through a one-shot loopback proxy (random path, 127.0.0.1 only) so it can
 * seek (mp4 moov at the end) while the Plex token stays in this process (never in ffmpeg's arguments). Results are cached.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { PlexFfmpeg } from './downloads.js';
import type { PlexHttp } from './transcode.js';

/** Plex subtitle codecs FriendFlix can turn into WebVTT (image subtitles such as PGS/VobSub are not offered). */
export const TEXT_SUB_CODECS = new Set(['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'mov_text', 'tx3g', 'text', 'smi', 'sami']);
export const MAX_VTT_BYTES = 10 * 1024 * 1024;
/** ffmpeg runtime limit for one embedded-subtitle extraction (it has to read the whole file through Plex) */
export const EXTRACT_TIMEOUT_MS = 180_000;

/**
 * Process-wide limit for ffmpeg subtitle conversions: `max` run at once, up to `maxQueue` wait (each at most `waitMs`), more are
 * refused at once. Keeps a burst of subtitle requests (many viewers, many tracks) from forking unbounded ffmpeg processes.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(readonly max = 2, readonly maxQueue = 16, readonly waitMs = 30_000) {}
  get running() { return this.active; }
  get waiting() { return this.queue.length; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      if (this.queue.length >= this.maxQueue) throw new Error('subtitle conversion queue full');
      await new Promise<void>((resolve, reject) => {
        const go = () => { clearTimeout(t); resolve(); };
        const t = setTimeout(() => {
          const i = this.queue.indexOf(go);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new Error('subtitle conversion queue timeout'));
        }, this.waitMs);
        this.queue.push(go);
      });
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next(); // hands the slot over (active stays)
      else this.active--;
    }
  }
}

/** The shared slots for all subtitle conversions of this process. */
export const subtitleSlots = new Semaphore(2, 16, 30_000);

/** UTF-8 when valid (BOM stripped), else Windows-1252 (old SRT files). */
export function decodeText(buf: Uint8Array): string {
  let s: string;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    s = new TextDecoder('windows-1252').decode(buf);
  }
  return s.replace(/^\uFEFF/, '');
}

const TS = /(\d{1,2}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/g;
const pad = (n: string, w: number) => n.padStart(w, '0');

/** SRT -> WebVTT: timestamps with '.', header, no stray ASS override tags; cue numbers are kept as cue identifiers. */
export function srtToVtt(srt: string): string {
  const body = srt.replace(/\r\n?/g, '\n').trim();
  const cues = body.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) return null;
    const timing = lines[at]!.replace(TS, (_m, h: string, mi: string, s: string, ms: string) => `${pad(h, 2)}:${pad(mi, 2)}:${pad(s, 2)}.${ms.padEnd(3, '0')}`);
    const text = lines.slice(at + 1).map((l) => l.replace(/\{\\[^}]*\}/g, '')).join('\n').replace(/-->/g, '->');
    const id = at > 0 ? lines.slice(0, at).join(' ').trim() : '';
    return `${id && !id.includes('-->') ? `${id}\n` : ''}${timing}\n${text}`;
  }).filter((c): c is string => c !== null);
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

const VTT_ARGS = (input: string, map?: string) => [
  '-nostdin', '-v', 'error', ...(input === 'pipe:0' ? ['-protocol_whitelist', 'pipe'] : ['-protocol_whitelist', 'http,tcp']),
  '-i', input, ...(map ? ['-map', map] : []), '-f', 'webvtt', 'pipe:1',
];

/** Converts a sidecar subtitle file (as downloaded from /library/streams/<id>) to WebVTT. */
export async function sidecarToVtt(ff: PlexFfmpeg, codec: string, bytes: Buffer, slots: Semaphore = subtitleSlots): Promise<Buffer> {
  const c = codec.toLowerCase();
  if (c === 'srt' || c === 'subrip') return Buffer.from(srtToVtt(decodeText(bytes)), 'utf8');
  if (c === 'vtt' || c === 'webvtt') {
    const t = decodeText(bytes);
    return Buffer.from(t.startsWith('WEBVTT') ? t : `WEBVTT\n\n${t}`, 'utf8');
  }
  return slots.run(() => ff.run(VTT_ARGS('pipe:0'), bytes, { maxBytes: MAX_VTT_BYTES }));
}

/**
 * Runs fn with a loopback URL that proxies GET/HEAD (with Range) to one Plex path. The URL carries a random path and dies with fn.
 */
export async function withPartProxy<T>(http: PlexHttp, plexPath: string, fn: (url: string) => Promise<T>): Promise<T> {
  const secret = `/${randomUUID()}`;
  const server = createServer((req, res) => {
    if (req.url !== secret || (req.method !== 'GET' && req.method !== 'HEAD')) return void res.writeHead(404).end();
    const headers: Record<string, string> = { accept: '*/*' };
    if (typeof req.headers.range === 'string') headers.range = req.headers.range;
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    http.fetch(plexPath, { method: req.method, headers, signal: ac.signal }).then((up) => {
      const out: Record<string, string> = {};
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const v = up.headers.get(h);
        if (v) out[h] = v;
      }
      res.writeHead(up.status, out);
      if (!up.body || req.method === 'HEAD') return void res.end();
      Readable.fromWeb(up.body as never).on('error', () => res.destroy()).pipe(res);
    }, () => res.writeHead(502).end());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}${secret}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** Embedded text stream (container index `index`) of a part -> WebVTT via ffmpeg. */
export function extractEmbedded(http: PlexHttp, ff: PlexFfmpeg, partKey: string, index: number, slots: Semaphore = subtitleSlots): Promise<Buffer> {
  return slots.run(() => withPartProxy(http, `/library/parts/${partKey}/0/file`,
    (url) => ff.run(VTT_ARGS(url, `0:${index}`), undefined, { maxBytes: MAX_VTT_BYTES, timeoutMs: EXTRACT_TIMEOUT_MS })));
}

/** Small LRU of finished conversions (single flight; failures are not kept). */
export class VttCache {
  private readonly m = new Map<string, { exp: number; p: Promise<Buffer> }>();
  constructor(private readonly max = 32, private readonly ttlMs = 3600_000) {}
  get(key: string, make: () => Promise<Buffer>): Promise<Buffer> {
    const hit = this.m.get(key);
    if (hit && hit.exp > Date.now()) {
      this.m.delete(key);
      this.m.set(key, hit);
      return hit.p;
    }
    const p = make();
    this.m.set(key, { exp: Date.now() + this.ttlMs, p });
    p.catch(() => { if (this.m.get(key)?.p === p) this.m.delete(key); });
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
    return p;
  }
}
