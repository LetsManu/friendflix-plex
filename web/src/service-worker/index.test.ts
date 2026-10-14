// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDir } from '../test-utils/fake-opfs';

// The service worker against fake Cache Storage, network and OPFS. SvelteKit's virtual modules are replaced by a small build.
vi.mock('$app/manifest', () => ({
  immutable: [
    { path: '_app/immutable/entry/start.A.js' }, { path: '_app/immutable/chunks/B.js' }, { path: '_app/immutable/nodes/9.Z.js' },
    { path: '_app/immutable/assets/inter-latin-wght-normal.F.woff2' }, { path: '_app/immutable/chunks/en.C.js' },
  ],
  assets: [{ path: 'icon-192.png' }, { path: 'favicon.svg' }, { path: 'robots.txt' }, { path: 'og.jpg' }],
  prerendered: [{ path: 'offline' }],
}));
vi.mock('$app/env', () => ({ version: 'v7' }));

const ORIGIN = 'https://portal.example';
const CACHE = 'ff-v7';
const OFFLINE_HTML = '<link href="./_app/immutable/entry/start.A.js" rel="modulepreload"><link href="./_app/immutable/chunks/B.js" rel="modulepreload"><link href="./_app/immutable/chunks/NOT-IN-BUILD.js" rel="modulepreload">';

/** Cache Storage double: name -> (url -> Response) */
class FakeCaches {
  stores = new Map<string, Map<string, Response>>();
  private store(name: string) { if (!this.stores.has(name)) this.stores.set(name, new Map()); return this.stores.get(name)!; }
  async open(name: string) {
    const s = this.store(name);
    const key = (r: RequestInfo | URL) => new URL(typeof r === 'string' || r instanceof URL ? r.toString() : r.url, ORIGIN).pathname;
    return {
      put: async (r: RequestInfo, res: Response) => void s.set(key(r), res),
      match: async (r: RequestInfo) => s.get(key(r))?.clone(),
      addAll: async (urls: string[]) => {
        for (const u of urls) {
          const res = await fetch(u);
          if (!res.ok) throw new TypeError(`addAll: ${u} ${res.status}`);
          s.set(key(u), res);
        }
      },
    };
  }
  async keys() { return [...this.stores.keys()]; }
  async delete(name: string) { return this.stores.delete(name); }
  async match(r: RequestInfo, o: { cacheName: string }) { return (await this.open(o.cacheName)).match(r); }
}

let caches: FakeCaches;
let net: Map<string, () => Response>;
let fetched: string[];
let netDown: boolean;
let handlers: Map<string, (e: unknown) => void>;
let sw: { skipWaiting: ReturnType<typeof vi.fn>; clients: { claim: ReturnType<typeof vi.fn> } };
let root: FakeDir;

beforeEach(async () => {
  caches = new FakeCaches();
  netDown = false;
  fetched = [];
  net = new Map<string, () => Response>([
    ['/offline', () => new Response(OFFLINE_HTML, { headers: { 'content-type': 'text/html' } })],
    ['/_app/locales.json', () => Response.json({ en: ['/_app/immutable/chunks/en.C.js', '/_app/immutable/chunks/gone.js'] })],
  ]);
  handlers = new Map();
  sw = { skipWaiting: vi.fn(async () => undefined), clients: { claim: vi.fn(async () => undefined) } };
  root = new FakeDir();
  vi.stubGlobal('caches', caches);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url, ORIGIN);
    fetched.push(url.pathname);
    if (netDown) throw new TypeError('Failed to fetch');
    const h = net.get(url.pathname);
    const res = h ? h() : new Response(`body of ${url.pathname}`, { status: 200 });
    return Object.defineProperty(res, 'type', { value: 'basic' }); // same-origin network response, as in a browser
  }));
  // in a worker, relative redirect targets resolve against the worker's location (Node has no base URL)
  const redirect = Response.redirect.bind(Response);
  vi.spyOn(Response, 'redirect').mockImplementation((url: string | URL, status?: number) => redirect(new URL(url, ORIGIN), status));
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  vi.stubGlobal('self', {
    ...sw,
    location: { origin: ORIGIN },
    registration: { showNotification: async () => undefined },
    addEventListener: (t: string, f: (e: unknown) => void) => handlers.set(t, f),
  });
  vi.resetModules();
  await import('./index');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** dispatches an extendable event and waits for everything it extended */
async function lifecycle(type: 'install' | 'activate') {
  const waits: Promise<unknown>[] = [];
  handlers.get(type)!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);
}
/** dispatches a fetch event; resolves the response given to respondWith, or null when the worker let the browser handle it */
async function request(path: string, init: { method?: string; mode?: string; headers?: Record<string, string>; origin?: string } = {}): Promise<Response | null> {
  let responded: Promise<Response> | null = null;
  const url = `${init.origin ?? ORIGIN}${path}`;
  const req = Object.assign(new Request(url, { method: init.method ?? 'GET', headers: init.headers }), {});
  Object.defineProperty(req, 'mode', { value: init.mode ?? 'cors' });
  handlers.get('fetch')!({ request: req, respondWith: (p: Promise<Response>) => { responded = p; } });
  return responded ? await responded : null;
}
async function rememberLocale(lang: string) {
  await (await caches.open('ff-meta')).put('/__ff/locale', new Response(lang));
}

describe('install', () => {
  it('precaches the offline hub, its shell modules of this build, the icons and the latin font; then activates at once', async () => {
    await lifecycle('install');
    const cached = [...caches.stores.get(CACHE)!.keys()].sort();
    expect(cached).toEqual([
      '/_app/immutable/assets/inter-latin-wght-normal.F.woff2',
      '/_app/immutable/chunks/B.js',
      '/_app/immutable/entry/start.A.js',
      '/favicon.svg',
      '/icon-192.png',
      '/offline',
    ]);
    expect(fetched).not.toContain('/_app/immutable/nodes/9.Z.js'); // route chunks: cached on first use only
    expect(fetched).not.toContain('/_app/locales.json'); // no remembered language (or German): nothing more
    expect(sw.skipWaiting).toHaveBeenCalled();
  });

  it('adds the chunks of the remembered UI language that belong to this build', async () => {
    await rememberLocale('en');
    await lifecycle('install');
    const cached = caches.stores.get(CACHE)!;
    expect(cached.has('/_app/immutable/chunks/en.C.js')).toBe(true);
    expect(cached.has('/_app/immutable/chunks/gone.js')).toBe(false);
  });

  it('a failing language manifest never fails the install', async () => {
    await rememberLocale('fr');
    net.set('/_app/locales.json', () => new Response('nope', { status: 500 }));
    await lifecycle('install');
    expect(sw.skipWaiting).toHaveBeenCalled();
    net.set('/_app/locales.json', () => { throw new TypeError('offline'); });
    await lifecycle('install');
  });
});

describe('activate', () => {
  it('deletes caches of older versions, keeps this version and the language meta cache, takes control', async () => {
    for (const n of ['ff-v6', 'ff-v5', CACHE, 'ff-meta', 'other-app']) await caches.open(n);
    await lifecycle('activate');
    expect([...caches.stores.keys()].sort()).toEqual(['ff-meta', CACHE, 'other-app'].sort());
    expect(sw.clients.claim).toHaveBeenCalled();
  });
});

describe('fetch', () => {
  it('leaves non-GET, cross-origin, ranged, API/media/auth and plain requests to the network', async () => {
    expect(await request('/api/me')).toBeNull();
    expect(await request('/media/Items/x/Images/Primary')).toBeNull();
    expect(await request('/health')).toBeNull();
    expect(await request('/_app/immutable/chunks/B.js', { method: 'POST' })).toBeNull();
    expect(await request('/_app/immutable/chunks/B.js', { origin: 'https://cdn.example' })).toBeNull();
    expect(await request('/_app/immutable/chunks/B.js', { headers: { range: 'bytes=0-' } })).toBeNull();
    expect(await request('/robots.txt')).toBeNull(); // not an icon, not immutable
  });

  it('immutable files and icons: cache first, filled on first use', async () => {
    const first = await request('/_app/immutable/nodes/9.Z.js');
    expect(await first!.text()).toBe('body of /_app/immutable/nodes/9.Z.js');
    await vi.waitFor(() => expect(caches.stores.get(CACHE)?.has('/_app/immutable/nodes/9.Z.js')).toBe(true));
    netDown = true;
    const again = await request('/_app/immutable/nodes/9.Z.js');
    expect(await again!.text()).toBe('body of /_app/immutable/nodes/9.Z.js');
  });

  it('does not cache failed responses', async () => {
    net.set('/icon-192.png', () => new Response('x', { status: 404 }));
    expect((await request('/icon-192.png'))!.status).toBe(404);
    await new Promise((r) => setTimeout(r, 0));
    expect(caches.stores.get(CACHE)?.has('/icon-192.png') ?? false).toBe(false);
  });

  it('pages come from the network; offline, /offline is served from the cache and every other page redirects there', async () => {
    expect(await (await request('/home', { mode: 'navigate' }))!.text()).toBe('body of /home');
    await lifecycle('install');
    netDown = true;
    const hub = await request('/offline/abc', { mode: 'navigate' });
    expect(await hub!.text()).toBe(OFFLINE_HTML);
    const other = await request('/title/123', { mode: 'navigate' });
    expect(other!.status).toBe(302);
    expect(other!.headers.get('location')).toBe(`${ORIGIN}/offline`);
  });

  it('offline before the hub was cached: a network error page', async () => {
    netDown = true;
    expect((await request('/offline', { mode: 'navigate' }))!.type).toBe('error');
  });
});

describe('offline downloads (/__dl/<id>/video.mp4)', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);
  beforeEach(async () => {
    const d = await (await root.getDirectoryHandle('ff-dl', { create: true })).getDirectoryHandle(ID, { create: true });
    (await d.getFileHandle('video.mp4', { create: true })).data = bytes;
  });
  const dl = (range?: string) => request(`/__dl/${ID}/video.mp4`, { headers: range ? { range } : {} });

  it('serves the whole file without Range', async () => {
    const r = (await dl())!;
    expect(r.status).toBe(200);
    expect(r.headers.get('content-length')).toBe('100');
    expect(r.headers.get('content-type')).toBe('video/mp4');
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes);
  });

  it('serves byte ranges: start-end, open end, suffix', async () => {
    const a = (await dl('bytes=10-19'))!;
    expect(a.status).toBe(206);
    expect(a.headers.get('content-range')).toBe('bytes 10-19/100');
    expect([...new Uint8Array(await a.arrayBuffer())]).toEqual([...bytes.subarray(10, 20)]);
    expect((await dl('bytes=90-'))!.headers.get('content-range')).toBe('bytes 90-99/100');
    expect((await dl('bytes=95-500'))!.headers.get('content-range')).toBe('bytes 95-99/100');
    const tail = (await dl('bytes=-5'))!;
    expect(tail.headers.get('content-range')).toBe('bytes 95-99/100');
    expect(tail.headers.get('content-length')).toBe('5');
  });

  it('416 for unsatisfiable or malformed ranges', async () => {
    for (const r of ['bytes=100-', 'bytes=50-10', 'bytes=-', 'items=0-1', 'bytes=0-1,5-6']) {
      const res = (await dl(r))!;
      expect(res.status).toBe(416);
      expect(res.headers.get('content-range')).toBe('bytes */100');
    }
  });

  it('404 for a download that is not on this device; ids must be UUIDs', async () => {
    expect((await request('/__dl/22222222-2222-4222-8222-222222222222/video.mp4'))!.status).toBe(404);
    expect(await request('/__dl/../video.mp4')).toBeNull();
  });
});
