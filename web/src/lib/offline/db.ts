// IndexedDB 'ff-offline' v1 -- the CONTRACT between the download manager (T4) and offline playback (T5).
// Stores:
//   downloads     keyPath 'id'      DownloadRecord
//   progressQueue keyPath 'itemId'  QueuedProgress (coalesced: newest event per item)
//   meta          out-of-line keys  'maxSeenTime' -> number (epoch ms), 'lastProfileId' -> string
// Date fields (expiresAt, validUntil, updatedAt) are epoch milliseconds (numbers).
import type { QualityId } from './size';

export type DownloadState = 'queued' | 'preparing' | 'downloading' | 'paused' | 'done' | 'error' | 'expired';
export interface DownloadSub { lang: string; title: string; file: string }
export interface DownloadRecord {
  id: string;
  itemId: string;
  profileId: string;
  profileName: string;
  title: string;
  seriesName?: string;
  s?: number;
  e?: number;
  runtimeTicks?: number;
  quality: QualityId;
  bytesTotal: number;
  bytesHave: number;
  etag: string;
  state: DownloadState;
  subs: DownloadSub[];
  expiresAt: number;
  validUntil: number;
  positionSec: number;
  updatedAt: number;
}
export interface QueuedProgress { itemId: string; downloadId: string; positionTicks: number; played: boolean; at: number }

export const DB_NAME = 'ff-offline';
export const DB_VERSION = 1;

/** newest event per item wins (equal timestamps: later array entry wins) */
export function coalesceProgress(events: QueuedProgress[]): QueuedProgress[] {
  const m = new Map<string, QueuedProgress>();
  for (const ev of events) {
    const cur = m.get(ev.itemId);
    if (!cur || ev.at >= cur.at) m.set(ev.itemId, ev);
  }
  return [...m.values()];
}

let dbp: Promise<IDBDatabase> | null = null;
export function openDb(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('downloads')) db.createObjectStore('downloads', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('progressQueue')) db.createObjectStore('progressQueue', { keyPath: 'itemId' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbp = null; reject(req.error); };
    });
  }
  return dbp;
}

const wrap = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

export async function getAllDownloads(): Promise<DownloadRecord[]> {
  const db = await openDb();
  return wrap(db.transaction('downloads').objectStore('downloads').getAll());
}
export async function getDownload(id: string): Promise<DownloadRecord | undefined> {
  const db = await openDb();
  return wrap(db.transaction('downloads').objectStore('downloads').get(id));
}
export async function putDownload(rec: DownloadRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('downloads', 'readwrite');
  tx.objectStore('downloads').put(rec);
  await done(tx);
}
export async function deleteDownloadRecord(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('downloads', 'readwrite');
  tx.objectStore('downloads').delete(id);
  await done(tx);
}

/** store a progress event, coalescing with a queued one for the same item (newest `at` wins) */
export async function queueProgress(ev: QueuedProgress): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('progressQueue', 'readwrite');
  const st = tx.objectStore('progressQueue');
  const cur = (await wrap(st.get(ev.itemId))) as QueuedProgress | undefined;
  if (!cur || ev.at >= cur.at) st.put(ev);
  await done(tx);
}
export async function getQueuedProgress(): Promise<QueuedProgress[]> {
  const db = await openDb();
  return wrap(db.transaction('progressQueue').objectStore('progressQueue').getAll());
}
export async function removeQueuedProgress(items: Array<{ itemId: string; at: number }>): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('progressQueue', 'readwrite');
  const st = tx.objectStore('progressQueue');
  for (const it of items) {
    const cur = (await wrap(st.get(it.itemId))) as QueuedProgress | undefined;
    if (cur && cur.at <= it.at) st.delete(it.itemId); // keep an event that arrived while we were syncing
  }
  await done(tx);
}

export async function getMeta<T = unknown>(key: 'maxSeenTime' | 'lastProfileId'): Promise<T | undefined> {
  const db = await openDb();
  return wrap(db.transaction('meta').objectStore('meta').get(key));
}
export async function setMeta(key: 'maxSeenTime' | 'lastProfileId', value: number | string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  await done(tx);
}
