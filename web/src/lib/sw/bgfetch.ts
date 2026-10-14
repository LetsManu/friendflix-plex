// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Background Fetch events in the service worker (page side: lib/offline/bgfetch.ts). A finished fetch is streamed into
 * OPFS ff-dl/<id>/video.mp4 and its IndexedDB record set to done (subtitles and pictures follow when the app opens).
 * Then the next ready download of the same profile starts. Open pages are told by a { type: 'ff-dl', id } message.
 * Kept free of the webworker lib so it type-checks next to the DOM lib.
 */
import { getAllDownloads, getDownload, putDownload, type DownloadRecord } from '../offline/db';
import { offlineLocale } from './locale';
import { bgTotal } from '../offline/bgfetch';

interface BgFetchRecord { responseReady: Promise<Response> }
interface BgRegistration { id: string; matchAll(): Promise<BgFetchRecord[]> }
export interface BgEvent { registration: BgRegistration; waitUntil(p: Promise<unknown>): void; updateUI?(o: { title: string }): Promise<void> }
interface WinClient { url: string; focus(): Promise<unknown>; navigate?(url: string): Promise<unknown>; postMessage(m: unknown): void }
interface SwScope {
  registration: { backgroundFetch?: { fetch(tag: string, urls: string[], o: Record<string, unknown>): Promise<unknown> } };
  clients: { matchAll(o: Record<string, unknown>): Promise<WinClient[]>; openWindow(url: string): Promise<unknown> };
  addEventListener(type: string, fn: (e: any) => void): void;
}
export interface BgDeps {
  getDownload(id: string): Promise<DownloadRecord | undefined>;
  getAll(): Promise<DownloadRecord[]>;
  putDownload(r: DownloadRecord): Promise<void>;
  /** stream the body into the download's video file; the size written. Throws where OPFS cannot be written here. */
  writeVideo(id: string, body: ReadableStream<Uint8Array>): Promise<number>;
  /** start a Background Fetch for this download; false when refused */
  startNext(r: DownloadRecord): Promise<boolean>;
  notify(id: string): Promise<void>;
  /** delete the download's OPFS folder */
  removeFiles(id: string): Promise<void>;
  locale(): Promise<string | null>;
  now(): number;
}

/** notification title when a download is finished (the service worker has no i18n runtime: copied from account.downloads.bgDone) */
const BG_DONE: Record<string, string> = {
  de: '„{title}“ ist heruntergeladen',
  en: '“{title}” is downloaded',
  es: '«{title}» se ha descargado',
  fr: '« {title} » est téléchargé',
  it: '«{title}» è stato scaricato',
  pl: '„{title}” został pobrany',
  tr: '“{title}” indirildi',
};
export const doneTitle = (lang: string | null, title: string): string => (BG_DONE[lang ?? ''] ?? BG_DONE.de!).replace('{title}', title);

const TAG = /^ff-dl-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const idOfTag = (tag: string): string | null => TAG.exec(tag)?.[1] ?? null;

/** the next download the service worker may start after `done`: same profile, waiting, ready on the server, from zero */
export function nextToChain(records: DownloadRecord[], done: DownloadRecord, now: number): DownloadRecord | undefined {
  return records.find((r) => r.id !== done.id && r.profileId === done.profileId && r.state === 'queued' && !!r.readyUrl && !r.noBg && r.bytesHave === 0 && r.expiresAt > now);
}

/** the record still belongs to this Background Fetch (the page did not pause, remove or revoke it meanwhile) */
const ours = (r: DownloadRecord | undefined): r is DownloadRecord => !!r && r.state === 'downloading' && r.via === 'bg';

/** the worker path takes over when the app opens (Range resume, no Background Fetch) */
const toWorker = (r: DownloadRecord, now: number): DownloadRecord => ({ ...r, state: 'queued', bytesHave: 0, via: undefined, noBg: true, updatedAt: now });

/** the fetched video written to OPFS: its size, or 0 when the response or the copy is not usable */
async function store(ev: BgEvent, id: string, d: BgDeps): Promise<number> {
  try {
    const [first] = await ev.registration.matchAll();
    const res = await first!.responseReady;
    const announced = Number(res.headers.get('content-length') ?? 0);
    if (!res.ok || !res.body) return 0;
    const size = await d.writeVideo(id, res.body);
    return announced && size !== announced ? 0 : size;
  } catch { return 0; }
}

export async function onSuccess(ev: BgEvent, d: BgDeps): Promise<void> {
  const id = idOfTag(ev.registration.id);
  const rec = id ? await d.getDownload(id) : undefined;
  if (!id || !rec) return; // removed meanwhile
  const size = await store(ev, id, d);
  // the copy can take a while: write onto the record as it is now, and only while it is still ours
  const now = await d.getDownload(id);
  const ok = size > 0 && ours(now);
  if (!ours(now)) await d.removeFiles(id).catch(() => undefined); // removed or revoked meanwhile: the file must not stay playable
  else await d.putDownload(ok ? { ...now, state: 'done', bytesHave: size, bytesTotal: size, via: undefined, extrasPending: true, updatedAt: d.now() } : toWorker(now, d.now()));
  await d.notify(id);
  if (!ok) return;
  try { await ev.updateUI?.({ title: doneTitle(await d.locale(), rec.title) }); } catch { /* the notification keeps the default text */ }
  const next = nextToChain(await d.getAll(), rec, d.now());
  if (next && (await d.startNext(next))) {
    await d.putDownload({ ...next, state: 'downloading', via: 'bg', bytesHave: 0, updatedAt: d.now() });
    await d.notify(next.id);
  }
}

export async function onFail(ev: BgEvent, d: BgDeps): Promise<void> {
  const id = idOfTag(ev.registration.id);
  const rec = id ? await d.getDownload(id) : undefined;
  if (!id || !rec) return;
  await d.putDownload(toWorker(rec, d.now()));
  await d.notify(id);
}

/** cancelled from the notification (a pause, remove or revoke by the page writes its own state before it aborts) */
export async function onAbort(ev: BgEvent, d: BgDeps): Promise<void> {
  const id = idOfTag(ev.registration.id);
  const rec = id ? await d.getDownload(id) : undefined;
  if (!id || !rec || rec.state !== 'downloading' || rec.via !== 'bg') return;
  await d.putDownload({ ...rec, state: 'paused', bytesHave: 0, via: undefined, updatedAt: d.now() });
  await d.notify(id);
}

export async function openDownloads(s: Pick<SwScope, 'clients'>): Promise<void> {
  const wins = await s.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const w = wins[0];
  if (w) { await w.navigate?.('/downloads').catch(() => undefined); await w.focus(); return; }
  await s.clients.openWindow('/downloads');
}

async function removeFiles(id: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await (await root.getDirectoryHandle('ff-dl')).removeEntry(id, { recursive: true });
}

async function writeVideo(id: string, body: ReadableStream<Uint8Array>): Promise<number> {
  const root = await navigator.storage.getDirectory();
  const dir = await (await root.getDirectoryHandle('ff-dl', { create: true })).getDirectoryHandle(id, { create: true });
  const fh = await dir.getFileHandle('video.mp4', { create: true });
  const w = await (fh as any).createWritable(); // TypeError where the browser has no writable streams in service workers
  await body.pipeTo(w);
  return (await fh.getFile()).size;
}

export function installBgFetch(sw: unknown): void {
  const s = sw as SwScope;
  const deps: BgDeps = {
    getDownload, getAll: getAllDownloads, putDownload, writeVideo, removeFiles, locale: offlineLocale, now: () => Date.now(),
    notify: async (id) => { for (const c of await s.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage({ type: 'ff-dl', id }); },
    startNext: async (r) => {
      try {
        const est = await navigator.storage.estimate();
        if (est.quota && 2.1 * r.bytesTotal > est.quota - (est.usage ?? 0)) return false; // the copy needs the size twice
        await s.registration.backgroundFetch!.fetch(`ff-dl-${r.id}`, [r.readyUrl!], {
          title: r.seriesName ? `${r.seriesName} S${r.s ?? '?'}:E${r.e ?? '?'} · ${r.title}` : r.title,
          icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
          ...(r.bytesTotal > 0 ? { downloadTotal: bgTotal(r.bytesTotal) } : {}),
        });
        return true;
      } catch { return false; }
    },
  };
  s.addEventListener('backgroundfetchsuccess', (e: BgEvent) => e.waitUntil(onSuccess(e, deps)));
  s.addEventListener('backgroundfetchfail', (e: BgEvent) => e.waitUntil(onFail(e, deps)));
  s.addEventListener('backgroundfetchabort', (e: BgEvent) => e.waitUntil(onAbort(e, deps)));
  s.addEventListener('backgroundfetchclick', (e: BgEvent) => e.waitUntil(openDownloads(s)));
}
