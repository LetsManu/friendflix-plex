// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadRecord } from '../offline/db';
import { doneTitle, idOfTag, installBgFetch, nextToChain, onAbort, onFail, onSuccess, openDownloads, type BgDeps, type BgEvent } from './bgfetch';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const NOW = 1_000_000;
const rec = (id: string, extra: Partial<DownloadRecord> = {}): DownloadRecord => ({
  id, itemId: `item-${id}`, profileId: 'p1', profileName: 'Lea', title: `Title ${id.slice(0, 1)}`, quality: 'hd', bytesTotal: 6, bytesHave: 0, etag: '',
  state: 'queued', subs: [], expiresAt: NOW + 1000, validUntil: NOW + 1000, positionSec: 0, updatedAt: 0, ...extra,
});

let db: Map<string, DownloadRecord>;
let notified: string[];
let written: Map<string, Uint8Array>;
let started: string[];
let deps: BgDeps;
let ui: string[];
let removed: string[];
const event = (tag: string, res?: Response): BgEvent => ({
  registration: { id: tag, matchAll: async () => (res ? [{ responseReady: Promise.resolve(res) }] : []) },
  waitUntil: () => undefined,
  updateUI: async (o) => { ui.push(o.title); },
});
const body = (s: string, headers: Record<string, string> = {}) => new Response(s, { headers: { 'content-length': String(s.length), ...headers } });

beforeEach(() => {
  db = new Map([[A, rec(A, { state: 'downloading', via: 'bg' })]]);
  notified = []; written = new Map(); started = []; ui = []; removed = [];
  deps = {
    getDownload: async (id) => db.get(id),
    getAll: async () => [...db.values()],
    putDownload: async (r) => { db.set(r.id, r); },
    writeVideo: async (id, b) => { const buf = new Uint8Array(await new Response(b).arrayBuffer()); written.set(id, buf); return buf.length; },
    startNext: async (r) => { started.push(r.id); return true; },
    notify: async (id) => { notified.push(id); },
    removeFiles: async (id) => { removed.push(id); },
    locale: async () => 'en',
    now: () => NOW,
  };
});

describe('service worker Background Fetch', () => {
  it('success: the file goes into OPFS, the record is done with extras pending, pages are told, the notification says done', async () => {
    await onSuccess(event(`ff-dl-${A}`, body('VIDEO!')), deps);
    expect(new TextDecoder().decode(written.get(A))).toBe('VIDEO!');
    expect(db.get(A)).toMatchObject({ state: 'done', bytesHave: 6, bytesTotal: 6, extrasPending: true, updatedAt: NOW });
    expect(db.get(A)!.via).toBeUndefined();
    expect(notified).toEqual([A]);
    expect(ui).toEqual(['“Title 1” is downloaded']);
  });

  it('a service worker that cannot write OPFS hands the download to the worker instead of marking it done', async () => {
    deps.writeVideo = async () => { throw new TypeError('createWritable is not a function'); };
    await onSuccess(event(`ff-dl-${A}`, body('VIDEO!')), deps);
    expect(db.get(A)).toMatchObject({ state: 'queued', bytesHave: 0, noBg: true });
    expect(db.get(A)!.via).toBeUndefined();
    expect(notified).toEqual([A]);
    expect(ui).toEqual([]);
  });

  it('a short or empty file, or an error status, is not done', async () => {
    const write = deps.writeVideo;
    deps.writeVideo = async () => 3;
    await onSuccess(event(`ff-dl-${A}`, body('VIDEO!')), deps);
    expect(db.get(A)!.state).toBe('queued');
    deps.writeVideo = write;
    db.set(A, rec(A, { state: 'downloading', via: 'bg' }));
    await onSuccess(event(`ff-dl-${A}`, new Response('', { status: 200 })), deps);
    expect(db.get(A)!.state).toBe('queued');
    db.set(A, rec(A, { state: 'downloading', via: 'bg' }));
    await onSuccess(event(`ff-dl-${A}`, new Response('x', { status: 403 })), deps);
    expect(db.get(A)!.state).toBe('queued');
    db.set(A, rec(A, { state: 'downloading', via: 'bg' }));
    await onSuccess(event(`ff-dl-${A}`), deps); // no record
    expect(db.get(A)!.noBg).toBe(true);
  });

  it('after a success the next ready download of the same profile starts in the background', async () => {
    db.set(B, rec(B, { readyUrl: `/media/d/${B}` }));
    await onSuccess(event(`ff-dl-${A}`, body('VIDEO!')), deps);
    expect(started).toEqual([B]);
    expect(db.get(B)).toMatchObject({ state: 'downloading', via: 'bg', bytesHave: 0 });
    expect(notified).toEqual([A, B]);
  });

  it('a refused next start leaves it waiting for the app', async () => {
    db.set(B, rec(B, { readyUrl: `/media/d/${B}` }));
    deps.startNext = async () => false;
    await onSuccess(event(`ff-dl-${A}`, body('VIDEO!')), deps);
    expect(db.get(B)!.state).toBe('queued');
  });

  it('nextToChain picks only the same profile, waiting, ready, Background-Fetch-able, from zero, not expired', () => {
    const done = rec(A);
    const others = [
      rec(B, { profileId: 'p2', readyUrl: '/u' }),
      rec(B, { state: 'paused', readyUrl: '/u' }),
      rec(B),
      rec(B, { readyUrl: '/u', noBg: true }),
      rec(B, { readyUrl: '/u', bytesHave: 5 }),
      rec(B, { readyUrl: '/u', expiresAt: NOW - 1 }),
      rec(A, { readyUrl: '/u' }),
    ];
    expect(nextToChain(others, done, NOW)).toBeUndefined();
    expect(nextToChain([...others, rec(C, { readyUrl: '/u' })], done, NOW)!.id).toBe(C);
  });

  it('a removed download or a foreign tag is ignored', async () => {
    await onSuccess(event(`ff-dl-${B}`, body('x')), deps);
    await onSuccess(event('other-tag', body('x')), deps);
    await onFail(event(`ff-dl-${B}`), deps);
    await onAbort(event('x'), deps);
    expect(notified).toEqual([]);
    expect(idOfTag(`ff-dl-${A}`)).toBe(A);
    expect(idOfTag(`ff-dl-${A}x`)).toBeNull();
  });

  it('fail hands the download to the worker', async () => {
    await onFail(event(`ff-dl-${A}`), deps);
    expect(db.get(A)).toMatchObject({ state: 'queued', bytesHave: 0, noBg: true });
    expect(notified).toEqual([A]);
  });

  it('abort from the notification pauses; an abort after the page changed the record leaves it alone', async () => {
    await onAbort(event(`ff-dl-${A}`), deps);
    expect(db.get(A)).toMatchObject({ state: 'paused', bytesHave: 0 });
    expect(notified).toEqual([A]);
    db.set(A, rec(A, { state: 'paused' }));
    notified = [];
    await onAbort(event(`ff-dl-${A}`), deps);
    expect(notified).toEqual([]);
  });

  it('done title per language, German without one', () => {
    expect(doneTitle('fr', 'X')).toBe('« X » est téléchargé');
    expect(doneTitle(null, 'X')).toBe('„X“ ist heruntergeladen');
    expect(doneTitle('xx', 'X')).toBe('„X“ ist heruntergeladen');
  });

  it('a click opens the downloads page in an open window, or a new one', async () => {
    const win = { url: '/', focus: vi.fn(async () => undefined), navigate: vi.fn(async () => undefined), postMessage: vi.fn() };
    await openDownloads({ clients: { matchAll: async () => [win], openWindow: vi.fn() } });
    expect(win.navigate).toHaveBeenCalledWith('/downloads');
    expect(win.focus).toHaveBeenCalled();
    const openWindow = vi.fn(async () => undefined);
    await openDownloads({ clients: { matchAll: async () => [], openWindow } });
    expect(openWindow).toHaveBeenCalledWith('/downloads');
  });

  it('installs the four Background Fetch listeners and posts the change to every window', async () => {
    const on = new Map<string, (e: any) => void>();
    const win = { url: '/', focus: async () => undefined, postMessage: vi.fn() };
    installBgFetch({ registration: {}, clients: { matchAll: async () => [win], openWindow: async () => undefined }, addEventListener: (t: string, f: (e: any) => void) => on.set(t, f) });
    expect([...on.keys()]).toEqual(['backgroundfetchsuccess', 'backgroundfetchfail', 'backgroundfetchabort', 'backgroundfetchclick']);
    const waits: Array<Promise<unknown>> = [];
    on.get('backgroundfetchclick')!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    on.get('backgroundfetchsuccess')!({ registration: { id: 'other', matchAll: async () => [] }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(win.postMessage).not.toHaveBeenCalled(); // foreign tag
  });

  it('a download removed during the copy is not brought back; its files go', async () => {
    const write = deps.writeVideo;
    deps.writeVideo = async (id, b) => { db.delete(A); return write(id, b); };
    await onSuccess(event(`ff-dl-${A}`, body('VIDEO!')), deps);
    expect(db.has(A)).toBe(false);
    expect(removed).toEqual([A]);
    expect(ui).toEqual([]);
  });

  it('a download paused or revoked during the copy keeps the state the page wrote', async () => {
    const write = deps.writeVideo;
    deps.writeVideo = async (id, b) => { db.set(A, rec(A, { state: 'expired', positionSec: 7 })); return write(id, b); };
    await onSuccess(event(`ff-dl-${A}`, body('VIDEO!')), deps);
    expect(db.get(A)).toMatchObject({ state: 'expired', positionSec: 7 });
    expect(removed).toEqual([A]);
    db.set(A, rec(A, { state: 'downloading', via: 'bg' }));
    deps.writeVideo = async () => { db.set(A, rec(A, { state: 'paused' })); throw new Error('x'); };
    await onSuccess(event(`ff-dl-${A}`, body('VIDEO!')), deps);
    expect(db.get(A)!.state).toBe('paused'); // not handed to the worker either
  });

  it('done merges onto the record as it is now (fields the page changed meanwhile survive)', async () => {
    const write = deps.writeVideo;
    deps.writeVideo = async (id, b) => { db.set(A, { ...db.get(A)!, validUntil: NOW + 99 }); return write(id, b); };
    await onSuccess(event(`ff-dl-${A}`, body('VIDEO!')), deps);
    expect(db.get(A)).toMatchObject({ state: 'done', validUntil: NOW + 99 });
  });
});
