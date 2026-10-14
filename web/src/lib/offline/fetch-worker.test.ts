// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDir, FakeFile } from '../../test-utils/fake-opfs';
import type { StartMsg, WorkerOut } from './fetch-worker';

// The download worker runs against a fake OPFS and a fake /media/d endpoint; messages to the page are recorded.
const ID = 'dl-1';
const URL_ = '/media/d/11111111-1111-4111-8111-111111111111';
const FILE = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);

let root: FakeDir;
let out: WorkerOut[];
let scope: { postMessage: (m: WorkerOut) => void; onmessage: ((e: { data: unknown }) => void) | null };
type Handler = (req: { url: string; headers: Record<string, string>; signal: AbortSignal }) => Response | Promise<Response>;
let handler: Handler;
let requests: Array<{ url: string; headers: Record<string, string> }>;

/** a body that delivers `chunks`, then optionally fails or hangs until the request is aborted */
function stream(chunks: Uint8Array[], end: 'close' | 'fail' | 'hang' = 'close', signal?: AbortSignal) {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) { c.enqueue(chunks[i++]!); return; }
      if (end === 'close') c.close();
      else if (end === 'fail') c.error(new TypeError('network reset'));
      else return new Promise<void>((_, rej) => signal?.addEventListener('abort', () => { const e = new DOMException('aborted', 'AbortError'); c.error(e); rej(e); }));
    },
  });
}
const chunked = (b: Uint8Array, size = 300) => Array.from({ length: Math.ceil(b.length / size) }, (_, i) => b.subarray(i * size, (i + 1) * size));
/** the server: honours Range like the gateway does */
const server = (opts: { etag?: string; body?: Uint8Array } = {}): Handler => ({ headers }) => {
  const body = opts.body ?? FILE;
  const etag = opts.etag ?? '"e1"';
  const m = /^bytes=(\d+)-$/.exec(headers.range ?? '');
  if (m && (!headers['if-range'] || headers['if-range'] === etag)) {
    const start = Number(m[1]);
    if (start >= body.length) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${body.length}` } });
    return new Response(stream(chunked(body.subarray(start))), { status: 206, headers: { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}`, etag } });
  }
  return new Response(stream(chunked(body)), { status: 200, headers: { 'content-length': String(body.length), etag } });
};

const video = () => root.find(`ff-dl/${ID}/video.mp4`) as FakeFile | undefined;
const start = (extra: Partial<StartMsg> = {}) => scope.onmessage!({ data: { cmd: 'start', id: ID, url: URL_, have: 0, etag: '', total: 0, extras: [], ...extra } satisfies StartMsg });
const finished = () => vi.waitFor(() => { const l = out.at(-1); if (!l || l.type === 'progress') throw new Error('still running'); return l; });

beforeEach(async () => {
  root = new FakeDir();
  out = [];
  requests = [];
  FakeFile.writeBudget = Infinity;
  handler = server();
  scope = { postMessage: (m) => out.push(m), onmessage: null };
  vi.stubGlobal('self', scope);
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    requests.push({ url, headers });
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return handler({ url, headers, signal: init.signal! });
  }));
  vi.resetModules();
  await import('./fetch-worker');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('fetch worker', () => {
  it('downloads the whole file into ff-dl/<id>/video.mp4 and reports progress and done', async () => {
    // progress is throttled to one message per 250 ms of performance.now(); a fresh test worker can be younger than
    // that, so pin the clock past the first window instead of depending on process age
    vi.spyOn(performance, 'now').mockReturnValue(10_000);
    start();
    expect(await finished()).toEqual({ type: 'done', id: ID, bytes: 1000, etag: '"e1"' });
    expect(video()!.data).toEqual(FILE);
    expect(video()!.open).toBe(false); // the sync handle is closed again
    expect(out.some((m) => m.type === 'progress' && m.total === 1000)).toBe(true);
    expect(requests[0]!.headers).toEqual({});
  });

  it('resumes with Range + If-Range from what is really on disk', async () => {
    await (await (await root.getDirectoryHandle('ff-dl', { create: true })).getDirectoryHandle(ID, { create: true })).getFileHandle('video.mp4', { create: true });
    video()!.data = FILE.slice(0, 400);
    start({ have: 600, etag: '"e1"', total: 1000 }); // the page believes 600, the disk has 400
    expect(await finished()).toMatchObject({ type: 'done', bytes: 1000 });
    expect(requests[0]!.headers).toEqual({ range: 'bytes=400-', 'if-range': '"e1"' });
    expect(video()!.data).toEqual(FILE);
  });

  it('starts over when the file changed on the server (200 instead of 206)', async () => {
    await (await (await root.getDirectoryHandle('ff-dl', { create: true })).getDirectoryHandle(ID, { create: true })).getFileHandle('video.mp4', { create: true });
    video()!.data = new Uint8Array(500).fill(9); // bytes of an older version
    handler = server({ etag: '"e2"' });
    start({ have: 500, etag: '"e1"' });
    expect(await finished()).toEqual({ type: 'done', id: ID, bytes: 1000, etag: '"e2"' });
    expect(video()!.data).toEqual(FILE);
  });

  it('416 with the full size on disk counts as complete; otherwise it restarts from zero', async () => {
    await (await (await root.getDirectoryHandle('ff-dl', { create: true })).getDirectoryHandle(ID, { create: true })).getFileHandle('video.mp4', { create: true });
    video()!.data = FILE.slice();
    start({ have: 1000, etag: '"e1"', total: 1000 });
    expect(await finished()).toMatchObject({ type: 'done', bytes: 1000 });
    expect(requests).toHaveLength(1);
  });

  it('416 for an offset that does not match the file size restarts from zero', async () => {
    await (await (await root.getDirectoryHandle('ff-dl', { create: true })).getDirectoryHandle(ID, { create: true })).getFileHandle('video.mp4', { create: true });
    video()!.data = new Uint8Array(1200).fill(7); // longer than the (new, smaller) file on the server
    start({ have: 1200, etag: '"e1"' });
    expect(await finished()).toMatchObject({ type: 'done', bytes: 1000 });
    expect(requests.map((r) => r.headers.range)).toEqual(['bytes=1200-', undefined]);
    expect(video()!.data).toEqual(FILE);
  });

  it('a 206 for the wrong offset restarts the file', async () => {
    await (await (await root.getDirectoryHandle('ff-dl', { create: true })).getDirectoryHandle(ID, { create: true })).getFileHandle('video.mp4', { create: true });
    video()!.data = FILE.slice(0, 100);
    let n = 0;
    handler = (req) => (n++ === 0
      ? new Response(stream([FILE.subarray(0, 10)]), { status: 206, headers: { 'content-range': 'bytes 0-9/1000' } })
      : server()(req));
    start({ have: 100 });
    expect(await finished()).toMatchObject({ type: 'done', bytes: 1000 });
    expect(requests.map((r) => r.headers.range)).toEqual(['bytes=100-', undefined]);
    expect(video()!.data).toEqual(FILE);
  });

  it.each([
    [401, 'auth'], [429, 'busy'], [403, 'gone'], [404, 'gone'], [410, 'gone'], [500, 'network'],
  ] as const)('HTTP %i is reported as %s', async (status, code) => {
    handler = () => new Response('x', { status });
    start();
    expect(await finished()).toMatchObject({ type: 'error', id: ID, code });
  });

  it('a network error before the response is reported as network', async () => {
    handler = () => { throw new TypeError('Failed to fetch'); };
    start();
    expect(await finished()).toMatchObject({ type: 'error', code: 'network', message: 'Failed to fetch' });
  });

  it('a connection reset mid-body keeps what arrived and reports it before the error', async () => {
    handler = () => new Response(stream([FILE.subarray(0, 300)], 'fail'), { status: 200, headers: { 'content-length': '1000' } });
    start();
    expect(await finished()).toMatchObject({ type: 'error', code: 'network' });
    expect(out.at(-2)).toMatchObject({ type: 'progress', have: 300, total: 1000 });
    expect(video()!.data).toEqual(FILE.subarray(0, 300));
  });

  it('a short write (storage full) is an io error', async () => {
    FakeFile.writeBudget = 500;
    start();
    expect(await finished()).toMatchObject({ type: 'error', code: 'io' });
  });

  it('fewer bytes than announced is a size error', async () => {
    handler = () => new Response(stream([FILE.subarray(0, 600)]), { status: 200, headers: { 'content-length': '1000' } });
    start();
    expect(await finished()).toMatchObject({ type: 'error', code: 'size', message: 'size mismatch (600 of 1000)' });
  });

  it('a file locked by another tab is an io error', async () => {
    const f = await (await (await root.getDirectoryHandle('ff-dl', { create: true })).getDirectoryHandle(ID, { create: true })).getFileHandle('video.mp4', { create: true });
    await f.createSyncAccessHandle(); // held elsewhere
    start();
    expect(await finished()).toMatchObject({ type: 'error', code: 'io' });
  });

  it('pause aborts the transfer and reports the bytes kept; a start while running is ignored', async () => {
    handler = ({ signal }) => new Response(stream([FILE.subarray(0, 300)], 'hang', signal), { status: 200, headers: { 'content-length': '1000' } });
    vi.spyOn(performance, 'now').mockReturnValue(10_000); // past the 250 ms progress throttle, see the first test
    start();
    await vi.waitFor(() => expect(out.some((m) => m.type === 'progress')).toBe(true));
    start({ id: 'other' }); // one download at a time
    scope.onmessage!({ data: { cmd: 'pause' } });
    expect(await finished()).toEqual({ type: 'paused', id: ID, have: 300 });
    expect(requests).toHaveLength(1);
  });

  it('pause while waiting for the response also reports paused', async () => {
    handler = ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    start();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    scope.onmessage!({ data: { cmd: 'pause' } });
    expect(await finished()).toEqual({ type: 'paused', id: ID, have: 0 });
  });

  it('fetches subtitles and images first, best effort, and skips files that already exist', async () => {
    const sub = new TextEncoder().encode('WEBVTT');
    handler = (req) => {
      if (req.url.endsWith('.vtt')) return new Response(sub);
      if (req.url.endsWith('poster')) return new Response('nope', { status: 404 });
      if (req.url.endsWith('backdrop')) throw new TypeError('offline');
      return server()(req);
    };
    const extras = [{ url: '/s.vtt', name: 'sub-de.vtt' }, { url: '/poster', name: 'poster.jpg' }, { url: '/backdrop', name: 'backdrop.jpg' }];
    start({ extras });
    expect(await finished()).toMatchObject({ type: 'done' });
    expect((root.find(`ff-dl/${ID}/sub-de.vtt`) as FakeFile).data).toEqual(sub);
    expect((root.find(`ff-dl/${ID}/poster.jpg`) as FakeFile).data.length).toBe(0);
    // second run: the subtitle is not fetched again
    requests = [];
    out = [];
    start({ extras: [extras[0]!], have: 1000, etag: '"e1"' });
    await finished();
    expect(requests.map((r) => r.url)).toEqual([URL_]);
  });

  it('extras only: fetches the side files, never the video, and reports the size of the video already on disk', async () => {
    start();
    await finished();
    requests = [];
    out = [];
    handler = (req) => (req.url.endsWith('.vtt') ? new Response('WEBVTT') : server()(req));
    start({ extras: [{ url: '/s.vtt', name: 'sub-de.vtt' }], extrasOnly: true, etag: '"e1"' });
    expect(await finished()).toEqual({ type: 'done', id: ID, bytes: 1000, etag: '"e1"' });
    expect(requests.map((r) => r.url)).toEqual(['/s.vtt']);
    expect(video()!.data).toEqual(FILE);
  });

  it('extras only: a pause while the side files load reports paused, not done', async () => {
    start();
    await finished();
    out = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    handler = async (req) => { await gate; if (req.signal.aborted) throw new DOMException('aborted', 'AbortError'); return new Response('WEBVTT'); };
    start({ extras: [{ url: '/s.vtt', name: 'sub-de.vtt' }], extrasOnly: true });
    await vi.waitFor(() => { if (!requests.some((r) => r.url === '/s.vtt')) throw new Error('not yet'); });
    scope.onmessage!({ data: { cmd: 'pause' } });
    release();
    expect(await finished()).toEqual({ type: 'paused', id: ID, have: 0 });
  });
});
