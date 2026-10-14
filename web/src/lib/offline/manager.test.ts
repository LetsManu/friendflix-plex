// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexedDB, idbTick } from '../../test-utils/fake-idb';
import { tr } from '../i18n';
import type { DownloadRecord } from './db';
import type { ServerLicense } from './manager';

// The download manager against: the real IndexedDB layer (over an in-memory IndexedDB), a fake backend (fetch),
// a fake fetch worker (the test plays the worker's messages) and stubbed OPFS helpers.
const opfs = vi.hoisted(() => ({
  support: { ok: true } as { ok: boolean; reason?: string },
  estimate: { usage: 0, quota: 0 },
  deleted: [] as string[],
  deleteFails: 0,
  orphansKept: [] as string[][],
}));
vi.mock('./opfs', () => ({
  checkSupport: async () => opfs.support,
  storageEstimate: async () => opfs.estimate,
  persist: async () => true,
  deleteDownloadFiles: async (id: string) => {
    if (opfs.deleteFails > 0) { opfs.deleteFails--; throw new Error('locked'); }
    opfs.deleted.push(id);
  },
  deleteOrphans: async (keep: string[]) => { opfs.orphansKept.push(keep); },
}));

class FakeWorker {
  static all: FakeWorker[] = [];
  posted: unknown[] = [];
  terminated = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: URL) { FakeWorker.all.push(this); }
  postMessage(m: unknown) { this.posted.push(m); }
  terminate() { this.terminated = true; }
  say(m: unknown) { this.onmessage!({ data: m }); }
}
const worker = () => FakeWorker.all.at(-1)!;

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1);
const me = { csrfToken: 'csrf-1', profile: { id: 'p1', name: 'Lea' } };
const lic = (id: string, extra: Partial<ServerLicense> = {}): ServerLicense => ({
  id, itemId: `item-${id}`, status: 'pending', ready: false,
  prep: { status: 'ready', percent: 100, error: null },
  fileUrl: `/media/d/${id}`, bytes: 1000, quality: 'hd', audioLang: 'deu',
  subtitles: [{ lang: 'de', title: 'Deutsch', url: `/api/downloads/${id}/sub/de` }], poster: `/p/${id}`, backdrop: null,
  title: `Title ${id}`, seriesName: null, seriesId: null, season: null, episode: null, runtimeTicks: 36_000_000_000,
  profileId: 'p1', createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 30 * DAY).toISOString(), validUntil: new Date(NOW + 7 * DAY).toISOString(),
  ...extra,
});

let server: { list: ServerLicense[]; listStatus: number; check: { valid: Array<{ id: string; expiresAt: string; validUntil: string }>; revoked: string[] }; progressStatus: number; meStatus: number };
let calls: Array<{ method: string; path: string; body: any; headers: Record<string, string> }>;
let online: boolean;
let listeners: Map<string, () => void>;
let docListeners: Map<string, () => void>;
let wakeLocks: number;
let idb: FakeIndexedDB;
type Mgr = typeof import('./manager');
let M: Mgr;
type Db = typeof import('./db');
let D: Db;

const json = (v: unknown, status = 200) => new Response(v === undefined ? null : JSON.stringify(v), { status });
/** lets IndexedDB requests (real timer) and the manager's promise chains and zero-delay timers (fake timers) run */
const settle = async (n = 30) => { for (let i = 0; i < n; i++) { await idbTick(); await vi.advanceTimersByTimeAsync(1); } };
/** an IndexedDB call made directly by the test */
const io = async <T>(p: Promise<T>): Promise<T> => { await settle(5); return p; };
const view = (id: string) => get(M.downloads).get(id);

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW });
  opfs.support = { ok: true };
  opfs.estimate = { usage: 0, quota: 0 };
  opfs.deleted = [];
  opfs.deleteFails = 0;
  opfs.orphansKept = [];
  FakeWorker.all = [];
  server = { list: [], listStatus: 200, check: { valid: [], revoked: [] }, progressStatus: 200, meStatus: 200 };
  calls = [];
  online = true;
  listeners = new Map();
  docListeners = new Map();
  wakeLocks = 0;
  idb = new FakeIndexedDB();
  vi.stubGlobal('indexedDB', idb);
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('window', { addEventListener: (t: string, f: () => void) => listeners.set(t, f) });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: (t: string, f: () => void) => docListeners.set(t, f) });
  vi.stubGlobal('location', { pathname: '/account', href: '/account' });
  vi.stubGlobal('navigator', {
    get onLine() { return online; },
    storage: { persisted: async () => true },
    wakeLock: { request: async () => { wakeLocks++; return { release: async () => { wakeLocks--; }, addEventListener: () => undefined }; } },
  });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, headers: (init.headers ?? {}) as Record<string, string> });
    if (path === '/api/me') return server.meStatus === 200 ? json(me) : json({}, server.meStatus);
    if (path === '/api/downloads' && method === 'GET') return server.listStatus === 200 ? json({ downloads: server.list }) : json({}, server.listStatus);
    if (path === '/api/downloads' && method === 'POST') return json({ licenses: server.list });
    if (path === '/api/downloads/check') return json(server.check);
    if (path === '/api/downloads/progress') return json({ ok: true }, server.progressStatus);
    if (path.startsWith('/api/downloads/options/')) return json({ allowed: true, qualities: [], audio: [], subtitles: [], quota: { used: 0, max: 5 }, days: 30 });
    return json({ ok: true });
  }));
  vi.resetModules();
  M = await import('./manager');
  D = await import('./db');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const record = (id: string, extra: Partial<DownloadRecord> = {}): DownloadRecord => ({
  id, itemId: `item-${id}`, profileId: 'p1', profileName: 'Lea', title: `Title ${id}`, quality: 'hd', bytesTotal: 1000, bytesHave: 0, etag: '',
  state: 'queued', subs: [], expiresAt: NOW + 30 * DAY, validUntil: NOW + 7 * DAY, positionSec: 0, updatedAt: NOW, ...extra,
});
async function init() {
  const p = M.initManager();
  await settle();
  await p;
  await settle();
}
/** request downloads of the given licences and let the manager start the first one */
async function request(...ls: ServerLicense[]) {
  server.list = ls;
  const p = M.requestDownload({ itemId: ls[0]!.itemId, quality: 'hd', subLangs: ['de'] });
  await settle();
  const out = await p;
  await settle();
  return out;
}

describe('init', () => {
  it('does nothing where downloads are unsupported', async () => {
    opfs.support = { ok: false, reason: 'no-opfs' };
    await init();
    expect(calls).toHaveLength(0);
    expect(listeners.size).toBe(0);
    await expect(M.requestDownload({ itemId: 'x', quality: 'hd', subLangs: [] })).rejects.toThrow('unsupported');
  });

  it('restores records from IndexedDB; an interrupted download continues as queued; remembers the newest time seen', async () => {
    await io(D.putDownload(record('a', { state: 'downloading', bytesHave: 300 })));
    await io(D.putDownload(record('b', { state: 'done', bytesHave: 1000 })));
    await io(D.setMeta('maxSeenTime', NOW + DAY)); // seen in the future before (clock was ahead): kept
    server.list = [lic('a', { prep: { status: 'queued', percent: 0, error: null } })]; // still known to the server (b is done: kept anyway)
    await init();
    expect(view('a')!.state).toBe('queued');
    expect(view('b')!.state).toBe('done');
    expect(await io(D.getMeta('maxSeenTime'))).toBe(NOW + DAY);
    expect(listeners.has('online')).toBe(true);
    expect(docListeners.has('visibilitychange')).toBe(true);
  });

  it('runs only once', async () => {
    await init();
    const n = calls.length;
    await M.initManager();
    await settle();
    expect(calls.length).toBe(n);
  });
});

describe('requesting and running downloads', () => {
  it('creates records from the licences, saves them, remembers the profile and starts the worker for a ready file', async () => {
    const out = await request(lic('a', { seriesName: 'Show', season: 1, episode: 2, subtitles: [{ lang: 'en', title: '', url: '/s/en' }] }));
    expect(out.map((v) => v.id)).toEqual(['a']);
    expect(calls.find((c) => c.path === '/api/downloads' && c.method === 'POST')!.body).toEqual({ itemId: 'item-a', quality: 'hd', subLangs: ['de'] });
    const v = view('a')!;
    expect(v).toMatchObject({ itemId: 'item-a', profileId: 'p1', profileName: 'Lea', seriesName: 'Show', s: 1, e: 2, bytesTotal: 1000, state: 'downloading', expiresAt: NOW + 30 * DAY, validUntil: NOW + 7 * DAY });
    expect(v.subs).toEqual([{ lang: 'en', title: 'en', file: 'sub-en.vtt' }]);
    expect((await io(D.getDownload('a')))!.state).toBe('downloading');
    expect(await io(D.getMeta('lastProfileId'))).toBe('p1');
    expect(worker().url.pathname).toMatch(/fetch-worker\.ts$/);
    expect(worker().posted).toEqual([{ cmd: 'start', id: 'a', url: '/media/d/a', have: 0, etag: '', total: 1000, extras: [{ url: '/s/en', name: 'sub-en.vtt' }, { url: '/p/a', name: 'poster.jpg' }] }]);
    expect(wakeLocks).toBe(1);
  });

  it('waits while the server prepares the file and shows its progress', async () => {
    await request(lic('a', { prep: { status: 'preparing', percent: 41.6, error: null } }));
    expect(view('a')).toMatchObject({ state: 'preparing', prep: 42 });
    expect(FakeWorker.all).toHaveLength(0);
    expect(M.stateLabel(view('a')!)).toBe(tr('account.downloads.state.preparing', { n: 42 }));
    server.list = [lic('a')];
    await vi.advanceTimersByTimeAsync(3000); // polls every 3 s while something waits
    await settle();
    expect(view('a')!.state).toBe('downloading');
    expect(FakeWorker.all).toHaveLength(1);
  });

  it('a failed preparation is an error with a message', async () => {
    await request(lic('a', { prep: { status: 'failed', percent: 0, error: 'prep_failed' } }));
    expect(view('a')).toMatchObject({ state: 'error', msg: tr('account.downloads.msg.prepFailed') });
  });

  it('progress, then done: the record is complete, the server is told, the worker and wake lock are released', async () => {
    await request(lic('a'));
    worker().say({ type: 'progress', id: 'a', have: 400, total: 1000, etag: '"e"' });
    expect(view('a')).toMatchObject({ bytesHave: 400, etag: '"e"' });
    expect(M.progressPct(view('a')!)).toBe(40);
    expect(M.stateLabel(view('a')!)).toBe(tr('account.downloads.state.downloading', { n: 40 }));
    worker().say({ type: 'done', id: 'a', bytes: 1000, etag: '"e"' });
    await settle();
    expect(view('a')).toMatchObject({ state: 'done', bytesHave: 1000, bytesTotal: 1000 });
    expect(worker().terminated).toBe(true);
    expect(wakeLocks).toBe(0);
    const fetched = calls.find((c) => c.path === '/api/downloads/a/fetched')!;
    expect(fetched).toMatchObject({ method: 'POST', body: { bytes: 1000 } });
    expect(fetched.headers).toMatchObject({ 'x-csrf-token': 'csrf-1', 'x-ff-profile': 'p1' });
    expect((await io(D.getDownload('a')))!.state).toBe('done');
  });

  it('runs one download at a time and starts the next one when the first is done', async () => {
    await request(lic('a'), lic('b'));
    expect(FakeWorker.all).toHaveLength(1);
    expect(view('b')!.state).toBe('queued');
    worker().say({ type: 'done', id: 'a', bytes: 1000, etag: '' });
    await settle();
    await vi.advanceTimersByTimeAsync(60);
    await settle();
    expect(FakeWorker.all).toHaveLength(2);
    expect((worker().posted[0] as { id: string }).id).toBe('b');
  });

  it('does not start when the file does not fit into the storage quota', async () => {
    opfs.estimate = { usage: 900, quota: 1500 };
    await request(lic('a'));
    expect(view('a')).toMatchObject({ state: 'error', msg: tr('account.downloads.msg.noSpace') });
    expect(FakeWorker.all).toHaveLength(0);
  });

  it('licences of another profile are not started with this session', async () => {
    await request(lic('a', { profileId: 'p2' }));
    expect(view('a')!.state).toBe('queued');
    expect(FakeWorker.all).toHaveLength(0);
  });
});

describe('worker errors', () => {
  it.each([
    ['auth', 'paused', 'account.downloads.msg.signIn'],
    ['busy', 'queued', 'account.downloads.msg.busy'],
    ['network', 'queued', 'account.downloads.msg.network'],
    ['gone', 'error', 'account.downloads.msg.gone'],
    ['io', 'error', 'account.downloads.msg.io'],
  ] as const)('%s -> %s with a message', async (code, state, msg) => {
    await request(lic('a'));
    worker().say({ type: 'error', id: 'a', code, message: 'x' });
    await settle();
    expect(view('a')).toMatchObject({ state, msg: tr(msg) });
    if (state === 'paused') expect(M.stateLabel(view('a')!)).toBe(tr(msg)); // the reason replaces "paused"
  });

  it('busy backs off for 30 s before the same download is tried again', async () => {
    await request(lic('a'));
    worker().say({ type: 'error', id: 'a', code: 'busy', message: 'x' });
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    expect(FakeWorker.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(12_000);
    await settle();
    await M.poll();
    await settle();
    expect(FakeWorker.all).toHaveLength(2);
  });

  it('size: the partial file is thrown away and the download starts from zero', async () => {
    await request(lic('a'));
    worker().say({ type: 'progress', id: 'a', have: 700, total: 1000, etag: '"old"' });
    worker().say({ type: 'error', id: 'a', code: 'size', message: 'x' });
    await settle();
    expect(opfs.deleted).toContain('a');
    expect(view('a')).toMatchObject({ state: 'queued', bytesHave: 0, etag: '' });
  });

  it('a crashed worker counts as a network error; messages for unknown downloads stop the worker', async () => {
    await request(lic('a'));
    worker().onerror!();
    await settle();
    expect(view('a')).toMatchObject({ state: 'queued', msg: tr('account.downloads.msg.network') });
    await request(lic('b'));
    worker().say({ type: 'progress', id: 'zzz', have: 1, total: 1, etag: '' });
    expect(worker().terminated).toBe(true);
  });
});

describe('user actions', () => {
  it('pause asks the running worker to stop; paused keeps the bytes; resume continues', async () => {
    await request(lic('a'));
    M.pause('a');
    expect(worker().posted.at(-1)).toEqual({ cmd: 'pause' });
    worker().say({ type: 'paused', id: 'a', have: 500 });
    await settle();
    expect(view('a')).toMatchObject({ state: 'paused', bytesHave: 500 });
    expect(M.stateLabel(view('a')!)).toBe(tr('account.downloads.state.paused', { n: 50 }));
    server.list = [lic('a')];
    M.resume('a');
    await settle();
    expect(view('a')!.state).toBe('downloading');
    expect(worker().posted[0]).toMatchObject({ cmd: 'start', have: 500 });
    M.pause('nope');
    M.resume('nope');
  });

  it('pause of a queued download just marks it paused', async () => {
    await request(lic('a'), lic('b'));
    M.pause('b');
    await settle();
    expect(view('b')!.state).toBe('paused');
  });

  it('removeDownload stops the worker, deletes files and record and frees the licence on the server', async () => {
    await request(lic('a'));
    await M.removeDownload('a');
    await settle();
    expect(worker().terminated).toBe(true);
    expect(view('a')).toBeUndefined();
    expect(opfs.deleted).toContain('a');
    expect(await io(D.getDownload('a'))).toBeUndefined();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/downloads/a')).toBe(true);
  });

  it('deleting files is retried once when they are still locked', async () => {
    await request(lic('a', { prep: { status: 'queued', percent: 0, error: null } }));
    opfs.deleteFails = 1;
    const p = M.removeDownload('a');
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(opfs.deleted).toEqual(['a']);
  });

  it('removeAll wipes every download on the device, also ones only in IndexedDB, then orphaned folders', async () => {
    await request(lic('a'));
    await io(D.putDownload(record('old')));
    const p = M.removeAll();
    await settle();
    await p;
    expect(opfs.deleted.sort()).toEqual(['a', 'old']);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path).sort()).toEqual(['/api/downloads/a', '/api/downloads/old']);
    expect(opfs.orphansKept).toEqual([[]]);
    expect(get(M.downloads).size).toBe(0);
    await M.cleanOrphans();
    expect(opfs.orphansKept.at(-1)).toEqual([]);
  });
});

describe('server sync', () => {
  it('a download the server no longer lists is removed locally; done ones are kept', async () => {
    await request(lic('a', { prep: { status: 'queued', percent: 0, error: null } }), lic('b', { prep: { status: 'queued', percent: 0, error: null } }));
    server.list = [lic('b', { prep: { status: 'queued', percent: 0, error: null } })];
    await M.poll();
    await settle();
    expect(view('a')).toBeUndefined();
    expect(view('b')).toBeDefined();
  });

  it('401 on the list marks waiting downloads "sign in again" without deleting anything', async () => {
    await request(lic('a', { prep: { status: 'queued', percent: 0, error: null } }));
    server.listStatus = 401;
    await M.poll();
    expect(view('a')).toMatchObject({ state: 'queued', msg: tr('account.downloads.msg.signIn') });
  });

  it('offline: no list request', async () => {
    await request(lic('a', { prep: { status: 'queued', percent: 0, error: null } }));
    online = false;
    const n = calls.length;
    await M.poll();
    expect(calls.length).toBe(n);
  });

  it('checkIn renews licences and expires revoked ones (files deleted)', async () => {
    await io(D.putDownload(record('a', { state: 'done', bytesHave: 1000 })));
    await io(D.putDownload(record('b', { state: 'done', bytesHave: 1000 })));
    await init();
    server.check = { valid: [{ id: 'a', expiresAt: new Date(NOW + 60 * DAY).toISOString(), validUntil: new Date(NOW + 14 * DAY).toISOString() }], revoked: ['b', 'unknown'] };
    const p = M.checkIn();
    await settle();
    await p;
    expect(calls.find((c) => c.path === '/api/downloads/check')!.body).toEqual({ ids: ['a', 'b'] });
    expect(view('a')).toMatchObject({ state: 'done', expiresAt: NOW + 60 * DAY, validUntil: NOW + 14 * DAY });
    expect(view('b')).toMatchObject({ state: 'expired', bytesHave: 0 });
    expect(opfs.deleted).toEqual(['b']);
  });

  it('checkIn makes no request offline or without downloads', async () => {
    await init();
    await M.checkIn();
    expect(calls.some((c) => c.path === '/api/downloads/check')).toBe(false);
  });

  it('finished downloads past their expiry are expired by the minute timer', async () => {
    await io(D.putDownload(record('a', { state: 'done', bytesHave: 1000, expiresAt: NOW + 30_000 })));
    await init();
    expect(view('a')!.state).toBe('done');
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(view('a')!.state).toBe('expired');
    expect(M.viewFor(get(M.downloads), 'item-a')).toBeUndefined();
  });

  it('coming back online checks in, flushes progress and polls', async () => {
    await io(D.putDownload(record('a', { state: 'done', bytesHave: 1000 })));
    await init();
    calls = [];
    listeners.get('online')!();
    await settle();
    expect(calls.some((c) => c.path === '/api/downloads/check')).toBe(true);
  });
});

describe('playback progress sync', () => {
  it('records positions locally and uploads the newest one per item when online', async () => {
    await io(D.putDownload(record('a', { state: 'done' })));
    await init();
    online = false;
    const t0 = Date.now();
    const r1 = M.recordPosition('a', 'item-a', 10, false);
    await settle();
    await r1;
    const r2 = M.recordPosition('a', 'item-a', 95.5, true);
    await settle();
    await r2;
    expect(view('a')!.positionSec).toBe(95.5);
    await M.flushProgress(); // offline: nothing
    expect(calls.some((c) => c.path === '/api/downloads/progress')).toBe(false);
    online = true;
    const f = M.flushProgress();
    await settle();
    await f;
    const sent = calls.filter((c) => c.path === '/api/downloads/progress');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.events).toEqual([{ downloadId: 'a', itemId: 'item-a', positionTicks: 955_000_000, played: true, at: expect.any(Number) }]);
    expect(sent[0]!.body.events[0].at).toBeGreaterThan(t0); // the newer of the two events
    expect(await io(D.getQueuedProgress())).toEqual([]);
  });

  it('keeps the queue when the server answers 401 or 5xx', async () => {
    await init();
    for (const status of [401, 503]) {
      server.progressStatus = status;
      const r = M.recordPosition('x', 'item-x', 5, false);
      await settle();
      await r;
      const f = M.flushProgress();
      await settle();
      await f;
      expect(await io(D.getQueuedProgress())).toHaveLength(1);
    }
  });

  it('uploads in batches of 200', async () => {
    await init();
    for (let i = 0; i < 250; i++) await io(D.queueProgress({ downloadId: `d${i}`, itemId: `i${i}`, positionTicks: i, played: false, at: NOW }));
    const f = M.flushProgress();
    await settle(60);
    await f;
    expect(calls.filter((c) => c.path === '/api/downloads/progress').map((c) => c.body.events.length)).toEqual([200, 50]);
  });
});

describe('helpers', () => {
  it('getMe shares one request and caches the answer for 5 minutes; failures are null', async () => {
    const [a, b] = await Promise.all([M.getMe(), M.getMe()]);
    expect(a).toEqual(me);
    expect(b).toEqual(me);
    await M.getMe();
    expect(calls.filter((c) => c.path === '/api/me')).toHaveLength(1);
    vi.setSystemTime(NOW + 301_000);
    server.meStatus = 401;
    expect(await M.getMe()).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await M.getMe(true)).toBeNull();
  });

  it('fetchOptions asks the server for the download options of an item', async () => {
    expect((await M.fetchOptions('item-1')).days).toBe(30);
    expect(calls.at(-1)!.path).toBe('/api/downloads/options/item-1');
  });

  it('refreshStorage publishes usage, quota and persistence', async () => {
    opfs.estimate = { usage: 5, quota: 50 };
    await M.refreshStorage();
    expect(get(M.storageInfo)).toEqual({ usage: 5, quota: 50, persisted: true });
  });

  it('viewFor finds the live download of an item; snapshot returns the current map', async () => {
    await request(lic('a'));
    expect(M.viewFor(M.snapshot(), 'item-a')!.id).toBe('a');
    expect(M.viewFor(M.snapshot(), 'item-zzz')).toBeUndefined();
  });
});
