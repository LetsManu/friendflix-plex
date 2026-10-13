import { describe, expect, it } from 'vitest';
import { APP_CODENAME, APP_VERSION, CODENAMES, codenameEntry, shortVersion } from './codenames';
import { EGG_START, eggTap, type EggState } from './egg';
import { parseNotes, plainInline } from './notes';
import de from '../i18n/locales/de/index';

describe('codenames', () => {
  it('26 snacks A–Z, each with a line in the German source', () => {
    expect(CODENAMES).toHaveLength(26);
    expect(CODENAMES.map((c) => c.name.normalize('NFD')[0]!.toUpperCase()).join('')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(Object.keys(de.version.snack).sort()).toEqual(CODENAMES.map((c) => c.id).sort());
  });
  it('version.json of this build', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(codenameEntry(APP_CODENAME)?.name).toBe(APP_CODENAME);
  });
  it('finds an entry by name or major', () => {
    expect(codenameEntry('Brezel')?.id).toBe('brezel');
    expect(codenameEntry(null, '5.1.0')?.id).toBe('eclair');
    expect(codenameEntry('Unknown', 'x')).toBeNull();
    expect(shortVersion('1.10.3')).toBe('1.10');
  });
});

describe('egg taps', () => {
  const run = (times: number[]) => {
    let s: EggState = EGG_START;
    return times.map((t) => { const r = eggTap(s, t); s = r.state; return r; });
  };
  it('hint from the 4th tap, opens on the 7th, then starts over', () => {
    const r = run([0, 100, 200, 300, 400, 500, 600, 700]);
    expect(r.map((x) => x.remaining)).toEqual([null, null, null, 3, 2, 1, null, null]);
    expect(r.map((x) => x.open)).toEqual([false, false, false, false, false, false, true, false]);
  });
  it('a long pause resets the count', () => {
    const r = run([0, 100, 200, 300, 5000]);
    expect(r[3]!.remaining).toBe(3);
    expect(r[4]!.remaining).toBeNull();
    expect(r[4]!.state.count).toBe(1);
  });
});

describe('release notes', () => {
  it('headings, lists, paragraphs; markup becomes text', () => {
    const b = parseNotes('### Streaming\n- **Adaptive** quality, see [docs](https://x)\n- <img src=x onerror=alert(1)>Night `mode`\n  continued\n\nSome &lt;b&gt; text\nmore.\n');
    expect(b).toEqual([
      { kind: 'h', text: 'Streaming' },
      { kind: 'ul', items: ['Adaptive quality, see docs', '<img src=x onerror=alert(1)>Night mode continued'] }, // unknown tags stay visible as text; the page renders it escaped, never as HTML
      { kind: 'p', text: 'Some <b> text more.' },
    ]);
  });
  it('plainInline strips tags but keeps the words', () => {
    expect(plainInline('<kbd>&lt;</kbd> and <kbd>&gt;</kbd>')).toBe('< and >');
    expect(parseNotes('')).toEqual([]);
  });
});
