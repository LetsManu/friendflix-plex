// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexedDB } from '../../test-utils/fake-idb';
import type { DownloadRecord, QueuedProgress } from './db';

let idb: FakeIndexedDB;
type Db = typeof import('./db');
let D: Db;

const rec = (id: string, extra: Partial<DownloadRecord> = {}): DownloadRecord => ({
  id, itemId: `item-${id}`, profileId: 'p1', profileName: 'Lea', title: 'Film', quality: 'hd', bytesTotal: 100, bytesHave: 0, etag: '',
  state: 'queued', subs: [], expiresAt: 1, validUntil: 1, positionSec: 0, updatedAt: 0, ...extra,
});
const ev = (itemId: string, at: number, positionTicks = at * 10): QueuedProgress => ({ itemId, downloadId: `d-${itemId}`, positionTicks, played: false, at });

beforeEach(async () => {
  idb = new FakeIndexedDB();
  vi.stubGlobal('indexedDB', idb);
  vi.resetModules();
  D = await import('./db');
});
afterEach(() => vi.unstubAllGlobals());

describe('ff-offline database', () => {
  it('creates the three stores on first open and opens only once per page', async () => {
    const db = await D.openDb();
    expect(await D.openDb()).toBe(db);
    expect(idb.opens).toBe(1);
    const fake = idb.dbs.get(D.DB_NAME)!;
    expect([...fake.stores.keys()].sort()).toEqual(['downloads', 'meta', 'progressQueue']);
    expect(fake.stores.get('downloads')!.keyPath).toBe('id');
    expect(fake.stores.get('progressQueue')!.keyPath).toBe('itemId');
    expect(fake.stores.get('meta')!.keyPath).toBeNull();
  });

  it('a failed open is retried on the next call', async () => {
    idb.failOpen = new Error('blocked');
    await expect(D.getAllDownloads()).rejects.toThrow('blocked');
    await expect(D.getAllDownloads()).resolves.toEqual([]);
    expect(idb.opens).toBe(2);
  });

  it('stores, replaces, reads and deletes download records', async () => {
    await D.putDownload(rec('a'));
    await D.putDownload(rec('b', { state: 'done' }));
    await D.putDownload(rec('a', { bytesHave: 50 }));
    expect((await D.getAllDownloads()).map((r) => [r.id, r.bytesHave, r.state])).toEqual([['a', 50, 'queued'], ['b', 0, 'done']]);
    expect((await D.getDownload('b'))?.state).toBe('done');
    await D.deleteDownloadRecord('a');
    expect(await D.getDownload('a')).toBeUndefined();
    expect(await D.getAllDownloads()).toHaveLength(1);
  });

  it('a failing write rejects', async () => {
    await D.openDb();
    idb.dbs.get(D.DB_NAME)!.failNext = new Error('QuotaExceededError');
    await expect(D.putDownload(rec('x'))).rejects.toThrow('QuotaExceededError');
  });

  it('meta values use out-of-line keys', async () => {
    expect(await D.getMeta('maxSeenTime')).toBeUndefined();
    await D.setMeta('maxSeenTime', 1234);
    await D.setMeta('lastProfileId', 'p9');
    expect(await D.getMeta<number>('maxSeenTime')).toBe(1234);
    expect(await D.getMeta<string>('lastProfileId')).toBe('p9');
  });
});

describe('progress queue', () => {
  it('keeps only the newest event per item; an older one never overwrites it', async () => {
    await D.queueProgress(ev('i1', 10));
    await D.queueProgress(ev('i1', 30));
    await D.queueProgress(ev('i1', 20)); // late, older event
    await D.queueProgress(ev('i2', 5));
    expect((await D.getQueuedProgress()).map((e) => [e.itemId, e.at])).toEqual([['i1', 30], ['i2', 5]]);
  });

  it('removing synced events keeps an event that arrived during the sync', async () => {
    await D.queueProgress(ev('i1', 10));
    await D.queueProgress(ev('i2', 10));
    const synced = await D.getQueuedProgress();
    await D.queueProgress(ev('i2', 11)); // newer position recorded while the upload ran
    await D.removeQueuedProgress(synced.map((e) => ({ itemId: e.itemId, at: e.at })));
    expect((await D.getQueuedProgress()).map((e) => [e.itemId, e.at])).toEqual([['i2', 11]]);
    await D.removeQueuedProgress([{ itemId: 'gone', at: 99 }]); // unknown item: nothing happens
    expect(await D.getQueuedProgress()).toHaveLength(1);
  });
});
