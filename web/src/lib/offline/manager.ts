// Download manager: store + queue + worker control + licence check-in + progress sync.
// Runs in the page (tab must stay open: no Background Fetch yet). Everything is a no-op where OPFS is unsupported.
import { writable, get } from 'svelte/store';
import { api } from '../api';
import {
  deleteDownloadRecord, getAllDownloads, getMeta, getQueuedProgress, putDownload, queueProgress, removeQueuedProgress, setMeta,
  coalesceProgress, type DownloadRecord, type DownloadState, type QueuedProgress,
} from './db';
import { checkSupport, deleteDownloadFiles, deleteOrphans, persist, storageEstimate, type Support } from './opfs';
import { bumpMaxSeen, toMs } from './license';
import { tr, type TKey } from '../i18n';
import { fitsQuota, estimateBytes, pct, type QualityId } from './size';
import { nextLocalState, pumpable } from './transition';
import type { StartMsg, WorkerOut } from './fetch-worker';

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

/** apply a server licence list entry to the matching local record (status, prep, expiry) */
function applyServer(l: ServerLicense) {
  const v = recs.get(l.id);
  if (!v) return;
  const ps = l.prep.status;
  srv.set(l.id, { ready: ps === 'ready', prep: prepOf(l), failed: ps === 'failed', fileUrl: l.fileUrl, bytes: l.bytes ?? 0, subs: l.subtitles, poster: l.poster ?? '', backdrop: l.backdrop ?? '' });
  if (l.expiresAt) v.expiresAt = toMs(l.expiresAt);
  if (l.validUntil) v.validUntil = toMs(l.validUntil);
  if (l.bytes && v.state !== 'done') v.bytesTotal = l.bytes;
  const t = nextLocalState(v.state, l.prep);
  if (t) {
    v.state = t.state; v.prep = t.prep;
    if (t.state === 'error') v.msg = tr('account.downloads.msg.prepFailed');
  }
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
      if (v.state === 'downloading') v.state = 'queued'; // the tab was closed mid-download: continue when ready
      recs.set(v.id, v);
    }
    publish();
    void refreshStorage();
    const seen = bumpMaxSeen((await getMeta<number>('maxSeenTime')) ?? 0, Date.now());
    await setMeta('maxSeenTime', seen);
  } catch { /* IndexedDB blocked: stays empty */ }
  window.addEventListener('online', () => { void checkIn(); void flushProgress(); void poll(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { void poll(); if (running) void acquireWake(); } });
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
  const open = [...recs.values()].some((v) => v.state === 'queued' || v.state === 'preparing' || v.state === 'downloading' || v.state === 'paused');
  if (!open || !navigator.onLine) { void pump(); return; }
  try {
    await getMe();
    const r = await fetch('/api/downloads', { credentials: 'same-origin' });
    if (r.status === 401) { markAuth(); return; }
    if (!r.ok) return;
    const j = await r.json();
    const list: ServerLicense[] = j.downloads ?? [];
    const ids = new Set(list.map((l) => l.id));
    for (const l of list) applyServer(l);
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
async function pump(): Promise<void> {
  if (running || !started) return;
  const now = Date.now();
  const next = [...recs.values()].find((v) => mine(v) && pumpable(v.state, !!srv.get(v.id)?.ready) && (retryAt.get(v.id) ?? 0) <= now);
  if (!next) return;
  const info = await storageEstimate();
  const need = (next.bytesTotal || estimateBytes(next.quality, next.runtimeTicks)) - next.bytesHave;
  if (!fitsQuota(need, info.quota, info.usage)) { await save(next, { state: 'error', msg: tr('account.downloads.msg.noSpace') }); return pump(); }
  startWorker(next);
}

function startWorker(v: DlView) {
  running = v.id;
  const s = srv.get(v.id)!;
  worker = new Worker(new URL('./fetch-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<WorkerOut>) => { void onWorker(ev.data); };
  worker.onerror = () => { void onWorker({ type: 'error', id: v.id, code: 'network', message: 'worker error' }); };
  const extras = [
    ...s.subs.map((x) => ({ url: x.url, name: `sub-${x.lang}.vtt` })),
    ...(s.poster ? [{ url: s.poster, name: 'poster.jpg' }] : []),
    ...(s.backdrop ? [{ url: s.backdrop, name: 'backdrop.jpg' }] : []),
  ];
  void save(v, { state: 'downloading', msg: undefined, prep: undefined });
  void acquireWake();
  const msg: StartMsg = { cmd: 'start', id: v.id, url: s.fileUrl, have: v.bytesHave, etag: v.etag, total: v.bytesTotal, extras };
  worker.postMessage(msg);
}

function stopWorker() {
  worker?.terminate();
  worker = null; running = '';
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
  stopWorker();
  if (m.type === 'done') {
    await save(v, { state: 'done', bytesHave: m.bytes, bytesTotal: m.bytes, etag: m.etag, msg: undefined });
    void raw(`/api/downloads/${v.id}/fetched`, 'POST', { bytes: m.bytes });
    void refreshStorage();
  } else if (m.type === 'paused') {
    await save(v, { state: 'paused', bytesHave: m.have });
  } else {
    const back = (ms: number) => retryAt.set(v.id, Date.now() + ms);
    if (m.code === 'auth') { await save(v, { state: 'paused', msg: tr('account.downloads.msg.signIn') }); }
    else if (m.code === 'busy') { back(30_000); await save(v, { state: 'queued', msg: tr('account.downloads.msg.busy') }); }
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
  if (running === id) worker?.postMessage({ cmd: 'pause' });
  else void save(v, { state: 'paused' });
}
export function resume(id: string) {
  const v = recs.get(id);
  if (!v) return;
  retryAt.delete(id);
  void save(v, { state: 'queued', msg: undefined }).then(() => poll());
}
export async function removeDownload(id: string): Promise<void> {
  if (running === id) stopWorker();
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
    if (running === id) stopWorker();
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
  return tr(L[v.state], { n: v.state === 'preparing' ? v.prep ?? 0 : progressPct(v) });
};
export const snapshot = (): Map<string, DlView> => get(downloads);
