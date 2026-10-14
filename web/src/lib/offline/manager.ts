// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Download manager: store + queue + worker control + licence check-in + progress sync.
// Runs in the page; phones pause it while the app is hidden (see pausesInBackground). Everything is a no-op where OPFS is unsupported.
import { writable, get } from 'svelte/store';
import { api } from '../api';
import {
  deleteDownloadRecord, getAllDownloads, getDownload, getMeta, getQueuedProgress, putDownload, queueProgress, removeQueuedProgress, setMeta,
  coalesceProgress, type DownloadRecord, type DownloadState, type QueuedProgress,
} from './db';
import { checkSupport, deleteDownloadFiles, deleteOrphans, persist, storageEstimate, type Support } from './opfs';
import { bumpMaxSeen, toMs } from './license';
import { tr, type TKey } from '../i18n';
import { fitsQuota, estimateBytes, pct, type QualityId } from './size';
import { nextLocalState, pumpable } from './transition';
import type { StartMsg, WorkerOut } from './fetch-worker';
import { abortBg, bgSupported, onBgMessage, startBg, watchBg } from './bgfetch';

/** record as shown in the UI: persisted fields + volatile ones (never written to IndexedDB) */
export interface DlView extends DownloadRecord { prep?: number; msg?: string }
export const downloads = writable<Map<string, DlView>>(new Map());
export const storageInfo = writable<{ usage: number; quota: number; persisted: boolean }>({ usage: 0, quota: 0, persisted: false });

export interface ServerSub { lang: string; title: string; url: string }
/** one licence as returned by GET /api/downloads and POST /api/downloads (backend LicenseView) */
export interface ServerLicense {
  id: string; itemId: string; status: 'pending' | 'fetched' | 'deleted' | 'revoked'; ready: boolean;
  prep: { status: 'queued' | 'preparing' | 'ready' | 'failed'; percent: number; /** error code ('prep_failed' | 'prep_gone'), not shown */ error: string | null };
  fileUrl: string; bytes: number | null; quality: QualityId; audioLang: string;
  subtitles: ServerSub[]; poster: string | null; backdrop: string | null;
  title: string; seriesName: string | null; seriesId: string | null; season: number | null; episode: number | null; runtimeTicks: number | null;
  profileId: string; createdAt: string; expiresAt: string; validUntil: string;
}
export interface DownloadOptions {
  allowed: boolean;
  qualities: Array<{ id: QualityId; label: string; height: number | null; estBytes: number }>;
  audio: Array<{ lang: string; title: string }>;
  subtitles: Array<{ lang: string; title: string }>;
  quota: { used: number; max: number };
  days: number;
  existingId?: string | null;
}
export interface DownloadRequest { itemId?: string; seriesId?: string; fromEpisodeId?: string; count?: number; quality: QualityId; audioLang?: string; subLangs: string[] }

/** whether downloads work in this browser (async: OPFS sync access is probed inside a worker once per tab) */
export const getSupport = (): Promise<Support> => checkSupport();

// ---- tiny raw API (no 401 -> login redirect: this also runs on the offline hub) ----
let meCache: { at: number; me: any } | null = null;
let meInflight: Promise<any | null> | null = null;
export async function getMe(force = false): Promise<any | null> {
  if (!force && meCache && Date.now() - meCache.at < 300_000) return meCache.me;
  // many callers (e.g. one DownloadButton per episode row) ask at once: share a single request
  if (meInflight) return meInflight;
  meInflight = (async () => {
    try {
      const r = await fetch('/api/me', { credentials: 'same-origin' });
      if (!r.ok) return null;
      meCache = { at: Date.now(), me: await r.json() };
      return meCache.me;
    } catch { return null; } finally { meInflight = null; }
  })();
  return meInflight;
}
async function raw(path: string, method: string, body?: unknown): Promise<{ status: number; json: any } | null> {
  const me = await getMe();
  if (!me) return null;
  try {
    const r = await fetch(path, {
      method, credentials: 'same-origin',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-csrf-token': me.csrfToken ?? '', ...(me.profile?.id ? { 'x-ff-profile': me.profile.id } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const t = await r.text();
    return { status: r.status, json: t ? JSON.parse(t) : null };
  } catch { return null; }
}

// Licenses belong to a profile: only those of the active profile are checked, synced, listed and started with this session.
const activeProfileId = (): string => meCache?.me?.profile?.id ?? '';
const mine = (v: { profileId: string }) => { const p = activeProfileId(); return !p || !v.profileId || v.profileId === p; };

// ---- state ----
const recs = new Map<string, DlView>();
const srv = new Map<string, { ready: boolean; prep: number; failed: boolean; fileUrl: string; bytes: number; subs: ServerSub[]; poster: string; backdrop: string }>();
let started = false, worker: Worker | null = null, running = '', wake: any = null, lastPut = 0;
/** a pause asked for because the app went to the background (not by the user) / the download the user paused / last time the page became visible */
let hiddenPause = false, userPause = '', visibleAt = 0;
/** the running download is a Background Fetch (no worker) / the worker only fetches the side files of this download */
let runningBg = false, extrasRun = '';
const retryAt = new Map<string, number>();
const publish = () => downloads.set(new Map(recs));
const persisted = (v: DlView): DownloadRecord => {
  const { prep: _p, msg: _m, ...r } = v;
  return r;
};
async function save(v: DlView, patch: Partial<DlView> = {}) {
  Object.assign(v, patch, { updatedAt: Date.now() });
  recs.set(v.id, v);
  publish();
  try { await putDownload(persisted(v)); } catch { /* storage unavailable */ }
}

const prepOf = (l: ServerLicense) => Math.max(0, Math.min(100, Math.round(l.prep.percent)));

function recordFromLicense(l: ServerLicense, me: any): DlView {
  const exp = toMs(l.expiresAt);
  const subs = l.subtitles.map((s) => ({ lang: s.lang, title: s.title || s.lang, file: `sub-${s.lang}.vtt` }));
  return {
    id: l.id, itemId: l.itemId, profileId: l.profileId || me?.profile?.id || '', profileName: me?.profile?.name ?? '',
    title: l.title, seriesName: l.seriesName ?? undefined, s: l.season ?? undefined, e: l.episode ?? undefined, runtimeTicks: l.runtimeTicks ?? undefined, quality: l.quality,
    bytesTotal: l.bytes ?? 0, bytesHave: 0, etag: '', state: 'queued', subs,
    expiresAt: exp, validUntil: toMs(l.validUntil) || exp, positionSec: 0, updatedAt: Date.now(),
  };
}

/** apply a server licence list entry to the matching local record (status, prep, expiry); true when it needs saving */
function applyServer(l: ServerLicense): boolean {
  const v = recs.get(l.id);
  if (!v) return false;
  const ps = l.prep.status;
  const newUrl = ps === 'ready' && v.readyUrl !== l.fileUrl;
  if (newUrl) v.readyUrl = l.fileUrl;
  srv.set(l.id, { ready: ps === 'ready', prep: prepOf(l), failed: ps === 'failed', fileUrl: l.fileUrl, bytes: l.bytes ?? 0, subs: l.subtitles, poster: l.poster ?? '', backdrop: l.backdrop ?? '' });
  if (l.expiresAt) v.expiresAt = toMs(l.expiresAt);
  if (l.validUntil) v.validUntil = toMs(l.validUntil);
  if (l.bytes && v.state !== 'done') v.bytesTotal = l.bytes;
  const t = nextLocalState(v.state, l.prep);
  if (t) {
    v.state = t.state; v.prep = t.prep;
    if (t.state === 'error') v.msg = tr('account.downloads.msg.prepFailed');
  }
  return newUrl;
}

// ---- lifecycle ----
let initP: Promise<void> | null = null;
export const initManager = (): Promise<void> => (initP ??= doInit());
async function doInit(): Promise<void> {
  if (!(await getSupport()).ok) return;
  started = true;
  try {
    for (const r of await getAllDownloads()) {
      const v: DlView = { ...r };
      if (v.state === 'downloading' && v.via !== 'bg') v.state = 'queued'; // the tab was closed mid-download: continue when ready
      recs.set(v.id, v);
    }
    publish();
    void refreshStorage();
    const seen = bumpMaxSeen((await getMeta<number>('maxSeenTime')) ?? 0, Date.now());
    await setMeta('maxSeenTime', seen);
  } catch { /* IndexedDB blocked: stays empty */ }
  window.addEventListener('online', () => { void checkIn(); void flushProgress(); void poll(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { visibleAt = Date.now(); retryAt.clear(); void poll(); if (running) void acquireWake(); }
    else pauseForBackground();
  });
  window.addEventListener('pagehide', pauseForBackground);
  onBgMessage((id) => { void syncFromServiceWorker(id); });
  // a Background Fetch kept running while the app was closed: follow it
  const bgRun = [...recs.values()].find((v) => v.state === 'downloading' && v.via === 'bg');
  if (bgRun) await syncFromServiceWorker(bgRun.id);
  setInterval(() => { void tick(); }, 60_000);
  void checkIn().then(() => flushProgress());
  void poll();
  pollLoop();
}

async function tick() {
  try { await setMeta('maxSeenTime', bumpMaxSeen((await getMeta<number>('maxSeenTime')) ?? 0, Date.now())); } catch { /* ignore */ }
  await sweepExpired();
  if (running) void raw(`/api/downloads/${running}`, 'GET'); // heartbeat: keeps the session alive during long downloads (raw: a 401 must not redirect to the login)
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
function pollLoop() {
  if (pollTimer) clearTimeout(pollTimer);
  const waiting = [...recs.values()].some((v) => v.state === 'queued' || v.state === 'preparing');
  pollTimer = setTimeout(async () => { await poll(); pollLoop(); }, waiting ? 3000 : 20_000);
}

export async function poll(): Promise<void> {
  const open = [...recs.values()].some((v) => v.state === 'queued' || v.state === 'preparing' || v.state === 'downloading' || v.state === 'paused' || v.extrasPending);
  if (!open || !navigator.onLine) { void pump(); return; }
  try {
    await getMe();
    const r = await fetch('/api/downloads', { credentials: 'same-origin' });
    if (r.status === 401) { markAuth(); return; }
    if (!r.ok) return;
    const j = await r.json();
    const list: ServerLicense[] = j.downloads ?? [];
    const ids = new Set(list.map((l) => l.id));
    for (const l of list) if (applyServer(l)) await save(recs.get(l.id)!);
    // gone on the server (revoked/deleted/expired there): drop local copy
    for (const v of [...recs.values()]) if (mine(v) && !ids.has(v.id) && v.state !== 'done' && v.state !== 'expired') await dropLocal(v.id);
    publish();
  } catch { /* offline */ }
  void pump();
}

function markAuth() {
  for (const v of recs.values()) if (v.state === 'queued' || v.state === 'preparing') v.msg = tr('account.downloads.msg.signIn');
  publish();
}

// ---- starting downloads ----
export async function fetchOptions(itemId: string): Promise<DownloadOptions> {
  return api<DownloadOptions>(`/api/downloads/options/${itemId}`);
}

export async function requestDownload(req: DownloadRequest): Promise<DlView[]> {
  if (!(await getSupport()).ok) throw new Error('unsupported');
  await initManager();
  void persist();
  const me = await getMe(true);
  const r: any = await api('/api/downloads', { method: 'POST', body: req });
  const list: ServerLicense[] = r.licenses ?? [];
  const out: DlView[] = [];
  for (const l of list) {
    const v = recs.get(l.id) ?? recordFromLicense(l, me);
    recs.set(v.id, v);
    applyServer(l);
    await save(v);
    out.push(v);
  }
  if (me?.profile?.id) { try { await setMeta('lastProfileId', me.profile.id); } catch { /* ignore */ } }
  pollLoop();
  void poll();
  return out;
}

// ---- running ----
/** phones freeze a hidden page (the fetch dies): pause cleanly there and continue at the same byte once visible again */
export const pausesInBackground = (): boolean => /iPad|iPhone|iPod|Android/.test(navigator.userAgent ?? '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const hidden = () => document.visibilityState === 'hidden';
function pauseForBackground() {
  if (!running || !worker || hiddenPause || userPause === running || !pausesInBackground()) return;
  hiddenPause = true;
  worker.postMessage({ cmd: 'pause' });
}
/** a dropped connection while hidden or just after coming back is the background freeze, not the network */
const backgroundDrop = () => hidden() || Date.now() - visibleAt < 2000;

async function pump(): Promise<void> {
  if (running || !started) return;
  if (hidden() && pausesInBackground()) return; // continues on visibilitychange
  const now = Date.now();
  const due = (v: DlView) => mine(v) && (retryAt.get(v.id) ?? 0) <= now;
  // subtitles and pictures of a download the service worker finished
  const extras = [...recs.values()].find((v) => due(v) && v.state === 'done' && v.extrasPending && srv.has(v.id));
  if (extras) { startWorker(extras, true); return; }
  if ([...recs.values()].some((v) => v.state === 'downloading' && v.via === 'bg')) return; // one download at a time, also when the service worker started it
  const next = [...recs.values()].find((v) => due(v) && pumpable(v.state, !!srv.get(v.id)?.ready));
  if (!next) return;
  running = next.id; // hold the slot over the awaits below
  // Background Fetch has no Range: a partly downloaded file continues in the worker
  const viaBg = !next.noBg && next.bytesHave === 0 && (await bgSupported());
  const info = await storageEstimate();
  const size = next.bytesTotal || estimateBytes(next.quality, next.runtimeTicks);
  const need = viaBg ? 2 * size : size - next.bytesHave; // the finished Background Fetch is copied once into OPFS
  const gone = running !== next.id || recs.get(next.id) !== next || next.state !== 'queued'; // removed or paused meanwhile
  if (running === next.id) running = '';
  if (gone) return;
  if (!fitsQuota(need, info.quota, info.usage)) { await save(next, { state: 'error', msg: tr('account.downloads.msg.noSpace') }); return pump(); }
  if (viaBg) return startBackground(next);
  startWorker(next);
}

const bgTitle = (v: DlView) => (v.seriesName ? `${v.seriesName} S${v.s ?? '?'}:E${v.e ?? '?'} · ${v.title}` : v.title);
async function startBackground(v: DlView) {
  running = v.id; runningBg = true;
  await save(v, { state: 'downloading', via: 'bg', bytesHave: 0, etag: '', msg: undefined, prep: undefined });
  const r = await startBg(v.id, srv.get(v.id)!.fileUrl, { title: bgTitle(v), total: v.bytesTotal, icon: '/icon-192.png' });
  if (r === 'failed') {
    running = ''; runningBg = false;
    await save(v, { via: undefined, noBg: true });
    startWorker(v);
    return;
  }
  await syncFromServiceWorker(v.id);
}

/**
 * Re-read a record the service worker may have changed (finished, failed, chained) and follow a running Background
 * Fetch. A record still marked running whose fetch is gone (browser data cleared, crash) goes to the worker.
 */
async function syncFromServiceWorker(id: string) {
  let r: DownloadRecord | undefined;
  try { r = await getDownload(id); } catch { return; }
  if (!r || !recs.has(id)) return;
  const v: DlView = { ...r };
  recs.set(id, v);
  if (v.state === 'downloading' && v.via === 'bg') {
    if (!running) { running = id; runningBg = true; } // the slot may be held by an extras run: follow the fetch anyway
    const follow = (n: number) => { const c = recs.get(id); if (c?.via === 'bg' && c.state === 'downloading') { c.bytesHave = n; publish(); } };
    if (await watchBg(id, follow)) { publish(); return; }
    await save(v, { state: 'queued', via: undefined, noBg: true, bytesHave: 0 });
  }
  if (running === id && runningBg) { running = ''; runningBg = false; }
  publish();
  setTimeout(() => { void pump(); }, 50);
}

/** stop whatever runs for this download: the worker or the Background Fetch (aborted before files are deleted) */
async function stopRun(id: string) {
  const v = recs.get(id);
  if (running === id) { if (runningBg) { running = ''; runningBg = false; } else stopWorker(); }
  if (v?.via !== 'bg') return;
  // written before the abort: the service worker's abort/success handlers then leave the record alone
  await save(v, { state: 'paused', bytesHave: 0, via: undefined });
  await abortBg(id);
}

function startWorker(v: DlView, extrasOnly = false) {
  running = v.id;
  extrasRun = extrasOnly ? v.id : '';
  const s = srv.get(v.id)!;
  worker = new Worker(new URL('./fetch-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<WorkerOut>) => { void onWorker(ev.data); };
  worker.onerror = () => { void onWorker({ type: 'error', id: v.id, code: 'network', message: 'worker error' }); };
  const extras = [
    ...s.subs.map((x) => ({ url: x.url, name: `sub-${x.lang}.vtt` })),
    ...(s.poster ? [{ url: s.poster, name: 'poster.jpg' }] : []),
    ...(s.backdrop ? [{ url: s.backdrop, name: 'backdrop.jpg' }] : []),
  ];
  if (!extrasOnly) void save(v, { state: 'downloading', msg: undefined, prep: undefined });
  void acquireWake();
  const msg: StartMsg = { cmd: 'start', id: v.id, url: s.fileUrl, have: v.bytesHave, etag: v.etag, total: v.bytesTotal, extras, ...(extrasOnly ? { extrasOnly: true } : {}) };
  worker.postMessage(msg);
}

function stopWorker() {
  worker?.terminate();
  worker = null; running = ''; extrasRun = '';
  void releaseWake();
}

async function onWorker(m: WorkerOut) {
  const v = recs.get(m.id);
  if (!v) { stopWorker(); return; }
  if (m.type === 'progress') {
    v.bytesHave = m.have; v.bytesTotal = m.total || v.bytesTotal; v.etag = m.etag || v.etag;
    recs.set(v.id, v); publish();
    if (Date.now() - lastPut > 2000) { lastPut = Date.now(); try { await putDownload(persisted(v)); } catch { /* ignore */ } }
    return;
  }
  const bgPause = hiddenPause && userPause !== v.id;
  const extrasOnly = extrasRun === v.id;
  hiddenPause = false; userPause = '';
  stopWorker();
  if (extrasOnly) {
    // the video came by Background Fetch: now the server learns it is fetched
    if (m.type === 'done') { await save(v, { extrasPending: false }); void raw(`/api/downloads/${v.id}/fetched`, 'POST', { bytes: m.bytes }); }
    else retryAt.set(v.id, Date.now() + 60_000);
  } else if (m.type === 'done') {
    await save(v, { state: 'done', bytesHave: m.bytes, bytesTotal: m.bytes, etag: m.etag, msg: undefined });
    void raw(`/api/downloads/${v.id}/fetched`, 'POST', { bytes: m.bytes });
    void refreshStorage();
  } else if (m.type === 'paused') {
    await save(v, bgPause ? { state: 'queued', bytesHave: m.have, msg: tr('account.downloads.msg.background') } : { state: 'paused', bytesHave: m.have });
  } else {
    const back = (ms: number) => retryAt.set(v.id, Date.now() + ms);
    if (m.code === 'auth') { await save(v, { state: 'paused', msg: tr('account.downloads.msg.signIn') }); }
    else if (m.code === 'busy') { back(30_000); await save(v, { state: 'queued', msg: tr('account.downloads.msg.busy') }); }
    else if (m.code === 'network' && backgroundDrop()) { await save(v, { state: 'queued', msg: tr('account.downloads.msg.background') }); }
    else if (m.code === 'network') { back(15_000); await save(v, { state: 'queued', msg: tr('account.downloads.msg.network') }); }
    else if (m.code === 'size') { await deleteDownloadFiles(v.id).catch(() => undefined); back(5_000); await save(v, { state: 'queued', bytesHave: 0, etag: '', msg: tr('account.downloads.msg.reload') }); }
    else if (m.code === 'gone') { await save(v, { state: 'error', msg: tr('account.downloads.msg.gone') }); }
    else { await save(v, { state: 'error', msg: tr('account.downloads.msg.io') }); }
  }
  setTimeout(() => { void pump(); }, 50);
  setTimeout(() => { void pump(); }, 15_500);
}

async function acquireWake() {
  try { if (!wake && 'wakeLock' in navigator && document.visibilityState === 'visible') { wake = await (navigator as any).wakeLock.request('screen'); wake.addEventListener?.('release', () => { wake = null; }); } } catch { wake = null; }
}
async function releaseWake() { try { await wake?.release(); } catch { /* ignore */ } wake = null; }

// ---- user actions ----
export function pause(id: string) {
  const v = recs.get(id);
  if (!v) return;
  if (v.via === 'bg') void stopRun(id).then(() => pump());
  else if (running === id && worker) { userPause = id; worker.postMessage({ cmd: 'pause' }); }
  else void save(v, { state: 'paused' });
}
export function resume(id: string) {
  const v = recs.get(id);
  if (!v) return;
  retryAt.delete(id);
  void save(v, { state: 'queued', msg: undefined }).then(() => poll());
}
export async function removeDownload(id: string): Promise<void> {
  await stopRun(id);
  await dropLocal(id);
  void raw(`/api/downloads/${id}`, 'DELETE');
  void refreshStorage();
  setTimeout(() => { void pump(); }, 50);
}
async function dropLocal(id: string) {
  recs.delete(id); srv.delete(id); retryAt.delete(id);
  publish();
  try { await deleteDownloadFiles(id); } catch { await new Promise((r) => setTimeout(r, 400)); await deleteDownloadFiles(id).catch(() => undefined); }
  try { await deleteDownloadRecord(id); } catch { /* ignore */ }
}
/** logout choice: wipe everything on this device (also works when the manager was never initialised: reads IndexedDB) */
export async function removeAll(): Promise<void> {
  stopWorker();
  const ids = new Set(recs.keys());
  try { for (const r of await getAllDownloads()) ids.add(r.id); } catch { /* no IndexedDB */ }
  await Promise.all([...ids].map(async (id) => {
    await stopRun(id);
    await raw(`/api/downloads/${id}`, 'DELETE'); // best effort: frees the licence slot
    await dropLocal(id);
  }));
  await deleteOrphans([]).catch(() => undefined);
}
export async function cleanOrphans(): Promise<void> { await deleteOrphans([...recs.keys()]); }

async function expire(v: DlView) {
  await deleteDownloadFiles(v.id).catch(() => undefined);
  await save(v, { state: 'expired', bytesHave: 0, msg: undefined });
}
async function sweepExpired() {
  const now = Date.now();
  for (const v of [...recs.values()]) if (v.state === 'done' && now > v.expiresAt) await expire(v);
}

/** online licence check: renews validUntil, applies revocations. Never deletes on 401 (session expiry keeps downloads). */
export async function checkIn(): Promise<void> {
  await sweepExpired();
  await getMe(); // fills the active profile (best effort)
  const ids = [...recs.values()].filter((v) => v.state !== 'expired' && mine(v)).map((v) => v.id).slice(0, 200);
  if (!ids.length || !navigator.onLine) return;
  const r = await raw('/api/downloads/check', 'POST', { ids });
  if (!r || r.status !== 200) return;
  for (const x of r.json?.valid ?? []) {
    const v = recs.get(x.id);
    if (v) await save(v, { expiresAt: toMs(x.expiresAt), validUntil: toMs(x.validUntil) });
  }
  for (const id of r.json?.revoked ?? []) {
    const v = recs.get(id);
    if (!v) continue;
    await stopRun(id);
    await expire(v);
  }
  try { await setMeta('maxSeenTime', bumpMaxSeen((await getMeta<number>('maxSeenTime')) ?? 0, Date.now())); } catch { /* ignore */ }
}

// ---- playback progress sync (also used by the offline player) ----
export async function recordPosition(downloadId: string, itemId: string, positionSec: number, played: boolean): Promise<void> {
  const v = recs.get(downloadId);
  if (v) await save(v, { positionSec });
  await queueProgress({ downloadId, itemId, positionTicks: Math.floor(positionSec * 10_000_000), played, at: Date.now() });
}
export async function flushProgress(): Promise<void> {
  if (!navigator.onLine) return;
  let q: QueuedProgress[];
  await getMe();
  try { q = coalesceProgress(await getQueuedProgress()).filter((e) => { const v = recs.get(e.downloadId); return !v || mine(v); }); } catch { return; } // other profiles' events stay queued
  if (!q.length) return;
  for (let i = 0; i < q.length; i += 200) {
    const part = q.slice(i, i + 200);
    const r = await raw('/api/downloads/progress', 'POST', { events: part });
    if (!r || r.status >= 500 || r.status === 401) return;
    await removeQueuedProgress(part.map((e) => ({ itemId: e.itemId, at: e.at })));
  }
}

export async function refreshStorage(): Promise<void> {
  const e = await storageEstimate();
  let p = false;
  try { p = await navigator.storage.persisted(); } catch { /* ignore */ }
  storageInfo.set({ ...e, persisted: p });
}

// ---- derived helpers for the UI ----
export const viewFor = (m: Map<string, DlView>, itemId: string): DlView | undefined =>
  [...m.values()].find((v) => v.itemId === itemId && v.state !== 'expired');
export const progressPct = (v: DlView): number => pct(v.bytesHave, v.bytesTotal);
export const stateLabel = (v: DlView): string => {
  const L: Record<DownloadState, TKey> = {
    queued: 'account.downloads.state.queued',
    preparing: 'account.downloads.state.preparing',
    downloading: 'account.downloads.state.downloading',
    paused: 'account.downloads.state.paused',
    done: 'account.downloads.state.done',
    error: 'account.downloads.state.error',
    expired: 'account.downloads.state.expired',
  };
  if (v.state === 'paused' && v.msg) return v.msg;
  if (v.state === 'queued' && v.msg === tr('account.downloads.msg.background')) return v.msg;
  return tr(L[v.state], { n: v.state === 'preparing' ? v.prep ?? 0 : progressPct(v) });
};
export const snapshot = (): Map<string, DlView> => get(downloads);
