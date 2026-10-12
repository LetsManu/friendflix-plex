/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
import { immutable, assets, prerendered } from '$app/manifest';
import { version } from '$app/env';

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `ff-${version}`;

import { basePrecache, LOCALE_MANIFEST, localeUrls, shellUrls } from './precache';
import { META_CACHE, offlineLocale } from '#lib/sw/locale';

// Never HTML besides the prerendered /offline hub (the app shell is always fetched fresh).
const abs = (p: string) => (p.startsWith('/') ? p : `/${p}`);
const staticFiles = assets.map((a) => abs(a.path)).filter((f) => /^\/(icon-.*\.png|apple-touch-icon\.png|favicon\.(svg|ico)|logo-icon\.svg|manifest\.webmanifest)$/.test(f));
const IMMUTABLE = immutable.map((a) => abs(a.path));
const PRERENDERED = prerendered.map((a) => abs(a.path));
/** cache-first (filled on first use): every immutable file of this version and the icons */
const ASSETS = new Set([...IMMUTABLE, ...staticFiles]);
const BYPASS = ['/api/', '/media/', '/auth/', '/ws/', '/internal/', '/health', '/metrics'];

/** Precache only what the offline hub needs to start: /offline, its modules/styles (read from its HTML), the latin font, the icons. */
async function precache() {
  const c = await caches.open(CACHE);
  await c.addAll(basePrecache({ immutable: IMMUTABLE, prerendered: PRERENDERED, statics: staticFiles }));
  const page = await c.match('/offline');
  if (!page) return;
  const shell = shellUrls(await page.text()).filter((u) => ASSETS.has(u));
  await c.addAll(shell);
  await precacheLocale(c).catch(() => undefined); // best effort: never fails the install
}

/** The chunks of the language the page last used (German is in the shell already), so /offline renders in it without network. */
async function precacheLocale(c: Cache) {
  const lang = await offlineLocale();
  if (!lang || lang === 'de') return;
  const res = await fetch(LOCALE_MANIFEST, { cache: 'no-cache' });
  if (!res.ok) return;
  const urls = localeUrls(await res.json(), lang, ASSETS);
  if (urls.length) await c.addAll(urls);
}

sw.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ff-') && k !== CACHE && k !== META_CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim())
  );
});

async function serveDownload(id: string, req: Request): Promise<Response> {
  const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('ff-dl')).getDirectoryHandle(id);
    const file = await (await dir.getFileHandle('video.mp4')).getFile();
    const size = file.size;
    const range = req.headers.get('range');
    if (!range) return new Response(file, { status: 200, headers: { ...headers, 'content-length': String(size) } });
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = 0, end = size - 1;
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); }
      else { start = Math.max(0, size - Number(m[2])); }
    } else return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
    return new Response(file.slice(start, end + 1), { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } });
  } catch {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
}

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== sw.location.origin) return;
  // Offline downloads: serve the OPFS file with Range support (WebKit cannot play blob URLs of big files reliably).
  const dl = /^\/__dl\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/video\.mp4$/.exec(url.pathname);
  if (dl) { event.respondWith(serveDownload(dl[1], req)); return; }
  if (req.headers.has('range')) return;
  if (BYPASS.some((p) => url.pathname === p.replace(/\/$/, '') || url.pathname.startsWith(p))) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => {
        const offline = await caches.match('/offline', { cacheName: CACHE });
        // the hub itself comes from the cache; every other page redirects there (no HTML is cached besides the prerendered /offline)
        if (url.pathname === '/offline' || url.pathname.startsWith('/offline/')) return offline ?? Response.error();
        return Response.redirect('/offline', 302);
      })
    );
    return;
  }

  if (ASSETS.has(url.pathname)) {
    event.respondWith(
      caches.match(req, { cacheName: CACHE }).then(async (hit) => {
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok && res.type === 'basic' && !res.redirected) {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
    );
  }
  // everything else: network only (no respondWith)
});

// push handlers
import { installPush } from '#lib/sw/push';
installPush(sw);
