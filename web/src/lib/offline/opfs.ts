// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Origin Private File System layout: ff-dl/<downloadId>/{video.mp4, sub-<lang>.vtt, poster.jpg, backdrop.jpg}
// Writes happen in fetch-worker.ts via createSyncAccessHandle; this module covers detection, reads, deletion and quota.
import { tr } from '#lib/i18n';

export const ROOT = 'ff-dl';

export type Unsupported = 'insecure' | 'no-opfs' | 'ios-install' | 'tv';
export interface Support { ok: boolean; reason?: Unsupported }

/** hint per reason, translated on every read (getters), so `SUPPORT_HINT[reason]` follows the UI language */
export const SUPPORT_HINT: Readonly<Record<Unsupported, string>> = {
  get insecure() { return tr('account.downloads.support.insecure'); },
  get 'no-opfs'() { return tr('account.downloads.support.noOpfs'); },
  get 'ios-install'() { return tr('account.downloads.support.iosInstall'); },
  get tv() { return tr('account.downloads.support.tv'); },
};

export const isIos = (): boolean => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => (navigator as any).standalone === true || matchMedia('(display-mode: standalone)').matches;

/**
 * Synchronous checks on the main thread: TV, secure context, OPFS directory API, workers, IndexedDB, iOS install.
 * `createSyncAccessHandle` (used by the fetch worker) only exists inside dedicated workers, so it is not tested here:
 * checkSupport() adds the worker probe.
 */
export function detectSupport(): Support {
  if (typeof window === 'undefined') return { ok: false, reason: 'no-opfs' };
  if (document.documentElement.classList.contains('tv') || sessionStorage.getItem('ff_tv') === '1') return { ok: false, reason: 'tv' };
  if (!window.isSecureContext) return { ok: false, reason: 'insecure' };
  const h = (globalThis as any).FileSystemFileHandle;
  if (!navigator.storage?.getDirectory || !h || typeof Worker === 'undefined' || !('indexedDB' in window)) return { ok: false, reason: 'no-opfs' };
  if (isIos() && !isStandalone()) return { ok: false, reason: 'ios-install' }; // non-installed sites are evicted after 7 days on WebKit
  return { ok: true };
}

/** sessionStorage key of the worker probe result ('1' / '0') */
export const PROBE_KEY = 'ff_opfs_sync';
let probed: boolean | null = null;
let probing: Promise<boolean> | null = null;
const makeProbeWorker = () => new Worker(new URL('./probe-worker.ts', import.meta.url), { type: 'module' });

/**
 * Whether OPFS sync access handles work in a dedicated worker (where the fetch worker writes). Asked once per tab
 * (cached in memory and sessionStorage); no answer within `timeoutMs` counts as unsupported (not cached).
 */
export function probeSyncAccess(make: () => Worker = makeProbeWorker, timeoutMs = 2000): Promise<boolean> {
  if (probed !== null) return Promise.resolve(probed);
  try { const c = sessionStorage.getItem(PROBE_KEY); if (c === '1' || c === '0') return Promise.resolve((probed = c === '1')); } catch { /* blocked storage */ }
  return (probing ??= new Promise<boolean>((resolve) => {
    let w: Worker | null = null, timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean, cache: boolean) => {
      clearTimeout(timer);
      try { w?.terminate(); } catch { /* ignore */ }
      probing = null;
      if (cache) { probed = ok; try { sessionStorage.setItem(PROBE_KEY, ok ? '1' : '0'); } catch { /* ignore */ } }
      resolve(ok);
    };
    try {
      w = make();
      w.onmessage = (e: MessageEvent) => finish(Boolean(e.data?.type === 'opfs-probe' && e.data.sync), true);
      w.onerror = () => finish(false, true);
      timer = setTimeout(() => finish(false, false), timeoutMs);
    } catch { finish(false, true); }
  }));
}
/** test hook: forget the probe result */
export function resetProbe(): void { probed = null; probing = null; }

/** Full check: the main-thread conditions, then the worker probe (only when everything else is fine). */
export async function checkSupport(make?: () => Worker, timeoutMs?: number): Promise<Support> {
  const s = detectSupport();
  if (!s.ok) return s;
  return (await probeSyncAccess(make, timeoutMs)) ? s : { ok: false, reason: 'no-opfs' };
}

export async function rootDir(create = true): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create });
}
export async function dlDir(id: string, create = false): Promise<FileSystemDirectoryHandle> {
  return (await rootDir(create)).getDirectoryHandle(id, { create });
}

/** the stored file (e.g. 'video.mp4') as a File, or null */
export async function getFile(id: string, name: string): Promise<File | null> {
  try { return await (await (await dlDir(id)).getFileHandle(name)).getFile(); } catch { return null; }
}
export async function fileSize(id: string, name = 'video.mp4'): Promise<number> {
  return (await getFile(id, name))?.size ?? 0;
}

/** removes the whole download folder; succeeds when it does not exist */
export async function deleteDownloadFiles(id: string): Promise<void> {
  try { await (await rootDir(false)).removeEntry(id, { recursive: true }); } catch (e: any) { if (e?.name !== 'NotFoundError') throw e; }
}
/** removes OPFS folders that no record points to (crashed or cancelled downloads) */
export const deleteOrphans = async (keep: string[]): Promise<void> => {
  let root: FileSystemDirectoryHandle;
  try { root = await rootDir(false); } catch { return; }
  for await (const name of (root as any).keys() as AsyncIterable<string>) if (!keep.includes(name)) await root.removeEntry(name, { recursive: true }).catch(() => undefined);
};

export interface StorageInfo { usage: number; quota: number }
export async function storageEstimate(): Promise<StorageInfo> {
  try { const e = await navigator.storage.estimate(); return { usage: e.usage ?? 0, quota: e.quota ?? 0 }; } catch { return { usage: 0, quota: 0 }; }
}
/** ask the browser not to evict our data; resolves whether it is persistent now */
export async function persist(): Promise<boolean> {
  try { if (await navigator.storage.persisted()) return true; return await navigator.storage.persist(); } catch { return false; }
}
