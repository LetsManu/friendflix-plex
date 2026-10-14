// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { airLog, AIRLOG_KEY, AIRLOG_MAX, clearAirLog, formatAirLog, readAirLog, srcKind } from './airplayLog';

function fakeStorage() {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe('AirPlay event log', () => {
  let ss: ReturnType<typeof fakeStorage>, ls: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    ss = fakeStorage(); ls = fakeStorage();
    vi.stubGlobal('sessionStorage', ss); vi.stubGlobal('localStorage', ls);
    clearAirLog();
  });
  afterEach(() => { vi.unstubAllGlobals(); clearAirLog(); });

  it('classifies the src without keeping it', () => {
    expect(srcKind('https://ff.example/media/c/TOKEN/Videos/x/master.m3u8')).toBe('token');
    expect(srcKind('/media/c/abc/x.m3u8')).toBe('token');
    expect(srcKind('blob:https://ff.example/1234')).toBe('blob');
    expect(srcKind('https://ff.example/media/hls/4000000/out.m3u8')).toBe('cookie');
    expect(srcKind('')).toBe('none');
    expect(srcKind(null)).toBe('none');
    expect(srcKind('https://elsewhere.example/x.mp4')).toBe('other');
  });

  it('stores entries in sessionStorage AND localStorage, with ms since the first entry', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000);
      airLog('pick', { src: 'blob:x', state: 'v' });
      vi.setSystemTime(1_002_500);
      airLog('wireless', { wireless: true, src: '/media/c/T/x', state: 'vRT', note: 'started' });
      const e = readAirLog();
      expect(e).toEqual([
        { t: 0, ev: 'pick', src: 'blob', state: 'v' },
        { t: 2500, ev: 'wireless', wireless: true, src: 'token', state: 'vRT', note: 'started' },
      ]);
      expect(JSON.parse(ss.m.get(AIRLOG_KEY)!).entries).toHaveLength(2);
      expect(JSON.parse(ls.m.get(AIRLOG_KEY)!).entries).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it('never stores URLs, tokens or cast ids (also not via a note)', () => {
    const token = 'https://ff.example/media/c/SECRETTOKEN123/Videos/x/master.m3u8';
    const castId = 'c'.repeat(32);
    airLog('token-ok', { src: token, state: 'B', note: `castId ${castId} url ${token}` });
    airLog('src', { src: 'blob:https://ff.example/abc', state: '', note: '/media/hls/4000000/out.m3u8 blob:https://ff.example/abc' });
    const raw = ss.m.get(AIRLOG_KEY)! + ls.m.get(AIRLOG_KEY)! + formatAirLog(readAirLog());
    for (const bad of ['SECRETTOKEN123', castId, 'ff.example', '/media/', 'blob:']) expect(raw).not.toContain(bad);
  });

  it(`keeps only the last ${AIRLOG_MAX} entries`, () => {
    for (let i = 0; i < AIRLOG_MAX + 15; i++) airLog('ev' + i, { src: '', state: '' });
    const e = readAirLog();
    expect(e).toHaveLength(AIRLOG_MAX);
    expect(e[0]!.ev).toBe('ev15');
    expect(e.at(-1)!.ev).toBe(`ev${AIRLOG_MAX + 14}`);
  });

  it('survives a reload: reads localStorage when sessionStorage is empty', () => {
    airLog('pick', { src: '', state: '' });
    ss.m.clear();
    expect(readAirLog().map((x) => x.ev)).toEqual(['pick']);
  });

  it('clear empties both stores', () => {
    airLog('pick', { src: '', state: '' });
    clearAirLog();
    expect(readAirLog()).toEqual([]);
    expect(ss.m.get(AIRLOG_KEY)).toBeUndefined();
    expect(ls.m.get(AIRLOG_KEY)).toBeUndefined();
  });

  it('works when storage throws (private mode) or is missing', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('x'); } });
    vi.stubGlobal('localStorage', undefined);
    airLog('pick', { src: '', state: '' });
    expect(readAirLog().map((x) => x.ev)).toEqual(['pick']);
    clearAirLog();
    expect(readAirLog()).toEqual([]);
  });

  it('ignores garbage in storage', () => {
    ss.m.set(AIRLOG_KEY, '{oops'); ls.m.set(AIRLOG_KEY, JSON.stringify({ entries: 'no' }));
    expect(readAirLog()).toEqual([]);
    airLog('pick', { src: '', state: '' });
    expect(readAirLog()).toHaveLength(1);
  });

  it('formats one line per entry for copying', () => {
    airLog('wireless', { wireless: false, src: '', state: 'A', note: 'debounced' });
    const txt = formatAirLog(readAirLog());
    expect(txt).toMatch(/\+0\.000s wireless w=0 src=none state=A debounced/);
  });

  it('trusted notes: tag names survive, URLs and long ids do not, cap 600; ordinary notes stay capped at 160', () => {
    airLog('probe-master', { src: '', state: '', trusted: true, note: `EXT-X-INDEPENDENT-SEGMENTS | https://x/y?k=1 | ${'a'.repeat(40)} | ${'z '.repeat(350)}` });
    const n = readAirLog()[0]!.note!;
    expect(n).toMatch(/^EXT-X-INDEPENDENT-SEGMENTS \| \[url\] \| \[id\]/);
    expect(n.length).toBe(600);
    clearAirLog();
    airLog('x', { src: '', state: '', note: 'z '.repeat(200) });
    expect(readAirLog()[0]!.note!.length).toBe(160);
  });

  it('keeps the ring buffer bounded with long notes', () => {
    for (let i = 0; i < AIRLOG_MAX + 20; i++) airLog('probe-master', { src: '', state: '', trusted: true, note: 'q '.repeat(400) });
    expect(readAirLog()).toHaveLength(AIRLOG_MAX);
  });
});
