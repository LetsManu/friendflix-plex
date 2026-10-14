// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Fake of the Plex transcoder / part / stream endpoints (behaviour from the block16 spike against PMS 1.43):
 * decision required before start (same session), X-Plex-Platform + Product mandatory, audio track = account-level part selection
 * snapshotted at start, the transcoder launches on the first index.m3u8 request (segments 404 before), index.m3u8 404 until the first segment exists, stop -> segments 404, sidecar SRT labelled text/html,
 * BIF index via Range. Everything else is delegated (P1's PlexFake for metadata/listings) or answered from the fixtures.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STREAM_TOKEN = 'plex-admin-token-SECRET-1234';
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const fixtureMeta = (name: string): Record<string, any> => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8')).MediaContainer.Metadata[0];

export const SRT = '1\r\n00:00:01,000 --> 00:00:03,500\r\nHello {\\an8}there\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,000\r\nSecond <i>line</i>\r\n';

export function bifHeader(count = 30, stepUnits = 2, mult = 0): Buffer {
  const b = Buffer.alloc(80);
  Buffer.from([0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32LE(count, 12);
  b.writeUInt32LE(mult, 16);
  b.writeUInt32LE(0, 64);
  b.writeUInt32LE(312, 68);
  b.writeUInt32LE(stepUnits, 72);
  b.writeUInt32LE(7763, 76);
  return b;
}

export interface FakeCall { method: string; path: string; search: string; headers: Record<string, string> }
interface Sess { rk: string; audio?: string; platform: string; query: URLSearchParams; polls: number; stopped: boolean; starts: number; launched: boolean }

export class TranscoderFake {
  calls: FakeCall[] = [];
  /** account-level audio selection per part */
  selected = new Map<string, string>();
  decided = new Set<string>();
  sessions = new Map<string, Sess>();
  /** 404 answers of index.m3u8 before it is ready (per start) */
  indexDelay = 1;
  segments = 4;
  decisionCode = 1001;
  meta = new Map<string, Record<string, any>>();
  /** extra delay inside decision (to widen race windows in lock tests) */
  decisionDelayMs = 0;
  /** per-stream decisions in the decision answer (PMS shape: Metadata[0].Media[0].Part[0].Stream[].decision); undefined = none reported */
  decisionStreams?: { video?: string; audio?: string };

  constructor(private readonly fallback?: typeof fetch) {
    for (const m of [fixtureMeta('movie1_detail'), fixtureMeta('ep_detail'), fixtureMeta('movie2_hevc_detail')]) this.meta.set(String(m.ratingKey), JSON.parse(JSON.stringify(m)));
  }

  partOf(rk: string) {
    return String(this.meta.get(rk)?.Media?.[0]?.Part?.[0]?.id ?? '');
  }

  readonly fetch: typeof fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    this.calls.push({ method, path: url.pathname, search: url.search, headers });
    const r = await this.route(method, url, headers);
    if (r) return r;
    if (this.fallback) return this.fallback(input, init);
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  private async route(method: string, url: URL, h: Record<string, string>): Promise<Response | null> {
    const path = url.pathname;
    const q = url.searchParams;
    if (h['x-plex-token'] !== STREAM_TOKEN) return new Response('<html>401</html>', { status: 401, headers: { 'content-type': 'text/html' } });
    const plat = q.get('X-Plex-Platform') ?? h['x-plex-platform'];
    const prod = q.get('X-Plex-Product') ?? h['x-plex-product'];
    let m = /^\/library\/parts\/(\d+)$/.exec(path);
    if (m && method === 'PUT') {
      if (q.get('audioStreamID')) this.selected.set(m[1]!, q.get('audioStreamID')!);
      return new Response(null, { status: 200 });
    }
    if (path === '/video/:/transcode/universal/decision') {
      if (!plat || !prod) return new Response('no client profile', { status: 400 });
      if (this.decisionDelayMs) await new Promise((r) => setTimeout(r, this.decisionDelayMs));
      this.decided.add(q.get('session') ?? '');
      const ds = this.decisionStreams;
      const Metadata = ds ? [{ Media: [{ selected: true, protocol: 'hls', Part: [{ decision: 'transcode', selected: true, Stream: [
        { streamType: 1, codec: 'h264', decision: ds.video, location: 'segments-video' },
        { streamType: 2, codec: 'aac', selected: true, decision: ds.audio, location: 'segments-audio' },
      ] }] }] }] : undefined;
      return Response.json({ MediaContainer: { generalDecisionCode: this.decisionCode, generalDecisionText: 'x', ...(Metadata ? { Metadata } : {}) } });
    }
    if (path === '/video/:/transcode/universal/start.m3u8') {
      const s = q.get('session') ?? '';
      if (!plat || !prod || !this.decided.has(s)) return new Response('session lacking decision', { status: 400 });
      const rk = /\/library\/metadata\/(\d+)/.exec(q.get('path') ?? '')?.[1] ?? '';
      const prev = this.sessions.get(s);
      this.sessions.set(s, { rk, audio: this.selected.get(this.partOf(rk)), platform: plat, query: q, polls: 0, stopped: false, starts: (prev?.starts ?? 0) + 1, launched: false });
      return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=891000,RESOLUTION=640x360\nsession/${s}/base/index.m3u8\n`, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
    }
    if (path === '/transcode/sessions') {
      // like PMS: running transcodes, key = the session parameter of the start
      return Response.json({ MediaContainer: { size: 0, TranscodeSession: [...this.sessions].filter(([, x]) => !x.stopped).map(([key]) => ({ key, protocol: 'hls' })) } });
    }
    if (path === '/video/:/transcode/universal/stop') {
      const s = this.sessions.get(q.get('session') ?? '');
      if (s) s.stopped = true;
      return new Response(null, { status: 200 });
    }
    m = /^\/video\/:\/transcode\/universal\/session\/([^/]+)\/base\/(index\.m3u8|\d+\.ts)$/.exec(path);
    if (m) {
      const s = this.sessions.get(m[1]!);
      if (!s || s.stopped) return new Response('not found', { status: 404 });
      if (m[2] === 'index.m3u8') {
        s.launched = true; // PMS launches the transcoder on the first playlist request
        if (s.polls++ < this.indexDelay) return new Response('not found', { status: 404 });
        const segs = Array.from({ length: this.segments }, (_, i) => `#EXTINF:8, nodesc\n${String(i).padStart(5, '0')}.ts`).join('\n');
        return new Response(`#EXTM3U\n#EXT-X-TARGETDURATION:8\n#EXT-X-ALLOW-CACHE:NO\n#EXT-X-MEDIA-SEQUENCE:0\n${segs}\n#EXT-X-ENDLIST\n`, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      }
      if (!s.launched) return new Response('not found', { status: 404 }); // segments 404 (no blocking) until then
      return new Response(`TS|${m[1]}|${Number(m[2]!.slice(0, -3))}|audio=${s.audio ?? '-'}`, { headers: { 'content-type': 'video/MP2T', 'x-plex-protocol': '1.0' } });
    }
    if (path === '/library/streams/5') return new Response(SRT, { headers: { 'content-type': 'text/html' } }); // sic: PMS labels SRT as html
    m = /^\/library\/streams\/\d+$/.exec(path);
    if (m) return new Response(null, { status: 501 });
    m = /^\/library\/parts\/(\d+)\/indexes\/sd$/.exec(path);
    if (m) return m[1] === '1' ? new Response(new Uint8Array(bifHeader()), { status: 206, headers: { 'content-range': 'bytes 0-79/245028' } }) : new Response(null, { status: 404 });
    m = /^\/library\/parts\/(\d+)\/0\/file$/.exec(path);
    if (m) return new Response(`PART${m[1]}-DATA`, { headers: { 'content-type': 'video/x-matroska', 'accept-ranges': 'bytes' } });
    m = /^\/library\/metadata\/(\d+)$/.exec(path);
    if (m && !this.fallback) {
      const meta = this.meta.get(m[1]!);
      return meta ? Response.json({ MediaContainer: { size: 1, Metadata: [meta] } }) : new Response(null, { status: 404 });
    }
    return null;
  }
}

/** ffmpeg stand-in: TS -> synthetic fMP4 boxes, subtitles -> a VTT naming its input. Records every call. */
export class FakeFfmpeg {
  calls: Array<{ args: string[]; input?: string; fetched?: string }> = [];
  async run(args: string[], input?: Buffer): Promise<Buffer> {
    const call: { args: string[]; input?: string; fetched?: string } = { args, input: input?.toString() };
    this.calls.push(call);
    if (args.includes('mpegts')) {
      const box = (type: string, body: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(type, 4, 'latin1'); return Buffer.concat([h, body]); };
      return Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', Buffer.from('INIT')), box('moof', Buffer.from(`F:${input}`)), box('mdat', input ?? Buffer.alloc(0))]);
    }
    const i = args.indexOf('-i');
    const src = args[i + 1]!;
    if (src.startsWith('http://127.0.0.1:')) {
      const r = await fetch(src); // the loopback proxy in front of the part
      call.fetched = await r.text();
      return Buffer.from(`WEBVTT\n\n00:00.000 --> 00:01.000\n${call.fetched}\n`);
    }
    return Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nconverted\n');
  }
}
