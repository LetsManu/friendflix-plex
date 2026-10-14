// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDir, FakeFile } from '../../test-utils/fake-opfs';
import { setLocale } from '../i18n';
import { SUPPORT_HINT, deleteDownloadFiles, deleteOrphans, fileSize, getFile, persist, storageEstimate, type Unsupported } from './opfs';

let root: FakeDir;
let storage: Record<string, unknown>;

async function put(id: string, name: string, bytes: number) {
  const d = await (await root.getDirectoryHandle('ff-dl', { create: true })).getDirectoryHandle(id, { create: true });
  (await d.getFileHandle(name, { create: true })).data = new Uint8Array(bytes);
}

beforeEach(() => {
  root = new FakeDir();
  storage = { getDirectory: async () => root };
  vi.stubGlobal('navigator', { storage });
});
afterEach(() => vi.unstubAllGlobals());

describe('OPFS files', () => {
  it('getFile / fileSize read stored files; missing files are null / 0', async () => {
    await put('a', 'video.mp4', 1234);
    await put('a', 'sub-de.vtt', 10);
    expect((await getFile('a', 'video.mp4'))?.size).toBe(1234);
    expect(await fileSize('a')).toBe(1234);
    expect(await fileSize('a', 'sub-de.vtt')).toBe(10);
    expect(await getFile('a', 'poster.jpg')).toBeNull();
    expect(await fileSize('nope')).toBe(0);
  });

  it('reading never creates folders', async () => {
    await getFile('x', 'video.mp4');
    expect(root.entries.size).toBe(0);
  });

  it('deleteDownloadFiles removes one download folder and succeeds when it is already gone', async () => {
    await put('a', 'video.mp4', 1);
    await put('b', 'video.mp4', 1);
    await deleteDownloadFiles('a');
    expect(root.find('ff-dl/a')).toBeUndefined();
    expect(root.find('ff-dl/b')).toBeInstanceOf(FakeDir);
    await expect(deleteDownloadFiles('a')).resolves.toBeUndefined();
    await expect(deleteDownloadFiles('a')).resolves.toBeUndefined();
  });

  it('deleteDownloadFiles passes other errors on (e.g. a file still open in a worker)', async () => {
    await put('a', 'video.mp4', 1);
    const dl = root.find('ff-dl') as FakeDir;
    dl.removeEntry = async () => { throw Object.assign(new Error('locked'), { name: 'NoModificationAllowedError' }); };
    await expect(deleteDownloadFiles('a')).rejects.toThrow('locked');
  });

  it('deleteOrphans keeps listed downloads and removes everything else; no folder: nothing to do', async () => {
    await expect(deleteOrphans([])).resolves.toBeUndefined();
    await put('keep', 'video.mp4', 1);
    await put('crashed', 'video.mp4', 1);
    await put('cancelled', 'poster.jpg', 1);
    await deleteOrphans(['keep']);
    expect([...(root.find('ff-dl') as FakeDir).entries.keys()]).toEqual(['keep']);
    expect(root.find('ff-dl/keep/video.mp4')).toBeInstanceOf(FakeFile);
  });
});

describe('quota and persistence', () => {
  it('storageEstimate reports usage/quota, zeros when unknown or failing', async () => {
    storage.estimate = async () => ({ usage: 10, quota: 100 });
    expect(await storageEstimate()).toEqual({ usage: 10, quota: 100 });
    storage.estimate = async () => ({});
    expect(await storageEstimate()).toEqual({ usage: 0, quota: 0 });
    storage.estimate = async () => { throw new Error('no'); };
    expect(await storageEstimate()).toEqual({ usage: 0, quota: 0 });
  });

  it('persist asks only when not persistent yet; false when the API fails', async () => {
    const ask = vi.fn(async () => false);
    storage.persisted = async () => true;
    storage.persist = ask;
    expect(await persist()).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    storage.persisted = async () => false;
    expect(await persist()).toBe(false);
    ask.mockResolvedValueOnce(true);
    expect(await persist()).toBe(true);
    storage.persisted = async () => { throw new Error('no'); };
    expect(await persist()).toBe(false);
  });
});

describe('support hints', () => {
  it('are translated on every read, so they follow a language switch', async () => {
    const reasons: Unsupported[] = ['insecure', 'no-opfs', 'ios-install', 'tv'];
    const de = reasons.map((r) => SUPPORT_HINT[r]);
    await setLocale('en');
    const en = reasons.map((r) => SUPPORT_HINT[r]);
    await setLocale('de');
    expect(new Set([...de, ...en]).size).toBe(8); // all present, all different
    expect(de.every((t) => t.length > 10 && !t.startsWith('account.'))).toBe(true);
  });
});
