// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chunkNotes, firstVariantUri, runProbe, scrubMessage, summarizeMaster, summarizeVariant, uriExt, uriKind } from './airplayProbe';

export const MASTER = `#EXTM3U
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Deutsch SECRETNAME",LANGUAGE="de",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8?api_key=SECRETKEY123&DeviceId=dev1"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=NO,URI="https://jf.example/Videos/abc123/sub.m3u8?api_key=SECRETKEY123"
#EXT-X-STREAM-INF:BANDWIDTH=8000000,AVERAGE-BANDWIDTH=7000000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=23.976,VIDEO-RANGE=SDR,AUDIO="audio",SUBTITLES="subs",PROGRAM-ID=1
main.m3u8?MediaSourceId=ms123&api_key=SECRETKEY123&PlaySessionId=ps9
#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=1000,RESOLUTION=320x180,CODECS="jpeg",URI="Trickplay/320/tiles.m3u8?api_key=SECRETKEY123"
`;

const VARIANT = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init.mp4?api_key=SECRETKEY123"
#EXTINF:6.006,
/media/c/TOKENTOKENTOKEN/hls1/main/0.mp4?runtimeTicks=0&api_key=SECRETKEY123
#EXTINF:6.006,
hls1/main/1.mp4?x=1
#EXT-X-ENDLIST
`;

const leaks = (s: string) => /SECRETKEY|SECRETNAME|api_key|https?:|\?|=ms123|abc123|TOKEN|dev1|jf\.example|Trickplay|tiles|audio\.m3u8|sub\.m3u8|main\.m3u8/.test(s);

describe('uri helpers', () => {
  it('kind and extension only', () => {
    expect(uriKind('a/b.m3u8')).toBe('rel');
    expect(uriKind('/a/b.m3u8')).toBe('root');
    expect(uriKind('https://x/a.ts')).toBe('abs');
    expect(uriKind('//x/a.ts')).toBe('abs');
    expect(uriExt('main.m3u8?api_key=x.ts')).toBe('.m3u8');
    expect(uriExt('a/b/seg.TS#frag.mp4')).toBe('.ts');
    expect(uriExt('noext?x=.mp4')).toBe('.none');
  });
});

describe('summarizeMaster', () => {
  const items = summarizeMaster(MASTER);
  const txt = items.join(' | ');
  it('never emits URIs, query strings, tokens, ids or names', () => {
    expect(leaks(txt)).toBe(false);
    expect(txt).not.toMatch(/NAME|PROGRAM-ID/);
  });
  it('keeps the allowlisted tags and attributes with values', () => {
    expect(items).toContain('EXTM3U');
    expect(items).toContain('EXT-X-INDEPENDENT-SEGMENTS');
    expect(txt).toContain('EXT-X-MEDIA TYPE=AUDIO GROUP-ID="audio" LANGUAGE="de" DEFAULT=YES AUTOSELECT=YES uri:rel .m3u8');
    expect(txt).toContain('EXT-X-MEDIA TYPE=SUBTITLES GROUP-ID="subs" LANGUAGE="en" DEFAULT=NO AUTOSELECT=NO uri:abs .m3u8');
    expect(txt).toContain('EXT-X-STREAM-INF BANDWIDTH=8000000 AVERAGE-BANDWIDTH=7000000 CODECS="avc1.640028,mp4a.40.2" RESOLUTION=1920x1080 FRAME-RATE=23.976 VIDEO-RANGE=SDR AUDIO="audio" SUBTITLES="subs"');
    expect(txt).toContain('uri:rel .m3u8');
    expect(txt).toContain('EXT-X-IMAGE-STREAM-INF BANDWIDTH=1000 RESOLUTION=320x180 CODECS="jpeg" uri:rel .m3u8');
  });
  it('replaces odd attribute values with ? and collapses repeats', () => {
    expect(summarizeMaster('#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="a/b?c=d"\nx.m3u8')).toEqual(['EXT-X-STREAM-INF BANDWIDTH=1 CODECS=?', 'uri:rel .m3u8']);
    expect(summarizeMaster('a.ts\nb.ts\nc.ts')).toEqual(['uri:rel .ts x3']);
  });
  it('survives garbage', () => {
    expect(summarizeMaster('')).toEqual([]);
    expect(summarizeMaster('#!!?api_key=SECRETKEY\n# comment https://x/y\n\u0000bin').join('|')).not.toMatch(/SECRETKEY|api_key|https|x\/y/);
  });
});

describe('firstVariantUri', () => {
  it('is the line after the first STREAM-INF, not a media or image URI', () => {
    expect(firstVariantUri(MASTER)).toBe('main.m3u8?MediaSourceId=ms123&api_key=SECRETKEY123&PlaySessionId=ps9');
    expect(firstVariantUri('#EXTM3U\nfoo.m3u8')).toBeNull();
  });
});

describe('summarizeVariant', () => {
  const s = summarizeVariant(VARIANT);
  it('has the playlist facts and no URI', () => {
    expect(s).toBe('VERSION=6 | TARGETDURATION=6 | PLAYLIST-TYPE=VOD | MEDIA-SEQUENCE=0 | INDEPENDENT-SEGMENTS | MAP | ENDLIST | EXTINF x2 | first uri:root .mp4');
    expect(leaks(s)).toBe(false);
  });
  it('MPEG-TS without MAP', () => {
    expect(summarizeVariant('#EXTM3U\n#EXTINF:3,\nseg0.ts\n')).toBe('EXTINF x1 | first uri:rel .ts');
  });
});

describe('scrubMessage', () => {
  it('removes URLs, /media paths and ids', () => {
    const m = scrubMessage('The operation failed https://ff.example/media/c/ABC/Videos/x/master.m3u8?x=1 at /media/c/TOK/y and ' + 'a'.repeat(40));
    expect(m).toBe('The operation failed <url> at <url> and <id>');
    expect(scrubMessage(undefined)).toBe('');
    expect(scrubMessage('x'.repeat(31) + ' ' + 'y'.repeat(300)).length).toBeLessThanOrEqual(200);
  });
});

describe('chunkNotes', () => {
  it('splits at item boundaries and caps the parts', () => {
    const items = Array.from({ length: 40 }, (_, i) => `ITEM-${i}-${'x'.repeat(30)}`);
    const parts = chunkNotes(items, 200, 3);
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.length <= 220)).toBe(true);
    expect(parts[2]).toMatch(/truncated/);
  });
});

describe('runProbe', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const res = (body: string, status = 200, ct = 'application/vnd.apple.mpegurl; charset=utf-8') => new Response(body, { status, headers: { 'content-type': ct } });

  it('logs master and variant; fetches without credentials, the variant resolved against the master', async () => {
    const f = vi.fn(async (u: string, _o?: unknown) => (u.includes('master') ? res(MASTER) : res(VARIANT)));
    vi.stubGlobal('fetch', f);
    const logs: [string, string][] = [];
    await runProbe('https://ff.example/media/c/TOK/Videos/x/master.m3u8', (e, n) => logs.push([e, n]), () => true);
    expect(f.mock.calls.map((c) => c[0])).toEqual(['https://ff.example/media/c/TOK/Videos/x/master.m3u8', 'https://ff.example/media/c/TOK/Videos/x/main.m3u8?MediaSourceId=ms123&api_key=SECRETKEY123&PlaySessionId=ps9']);
    expect(f.mock.calls[0]![1]).toEqual({ credentials: 'omit', cache: 'no-store' });
    expect(logs.map((l) => l[0])).toEqual(['probe-master', 'probe-master', 'probe-variant']);
    expect(logs[0]![1]).toMatch(/^HTTP 200 application\/vnd\.apple\.mpegurl \d+ B \| EXTM3U/);
    expect(logs[1]![1]).toMatch(/^part 2: /);
    expect(logs[2]![1]).toMatch(/^HTTP 200 application\/vnd\.apple\.mpegurl \d+ B \| VERSION=6/);
    expect(leaks(logs.map((l) => l[1]).join('\n'))).toBe(false);
  });

  it('non-200 master: status logged, no variant fetch', async () => {
    const f = vi.fn(async () => res('nope', 403, 'text/plain'));
    vi.stubGlobal('fetch', f);
    const logs: [string, string][] = [];
    await runProbe('https://ff.example/m', (e, n) => logs.push([e, n]), () => true);
    expect(f).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([['probe-master', 'HTTP 403 text/plain 4 B (not 200)']]);
  });

  it('network / CORS error: logs the error name only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Load failed for https://ff.example/media/c/TOK/x'); }));
    const logs: [string, string][] = [];
    await runProbe('https://ff.example/m', (e, n) => logs.push([e, n]), () => true);
    expect(logs).toEqual([['probe-master-fail', 'error TypeError']]);
  });

  it('variant failure is logged, nothing thrown', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { if (u.includes('master')) return res(MASTER); throw new TypeError('x'); }));
    const logs: [string, string][] = [];
    await expect(runProbe('https://ff.example/master.m3u8', (e, n) => logs.push([e, n]), () => true)).resolves.toBeUndefined();
    expect(logs.map((l) => l[0])).toEqual(['probe-master', 'probe-master', 'probe-variant-fail']);
  });

  it('logs nothing once dead', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(MASTER)));
    const logs: [string, string][] = [];
    let alive = true;
    const p = runProbe('https://ff.example/master.m3u8', (e, n) => logs.push([e, n]), () => alive);
    alive = false;
    await p;
    expect(logs).toEqual([]);
  });
});
