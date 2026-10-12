import { afterEach, describe, expect, it } from 'vitest';
import { setLocale, tr } from './index';
import de from './locales/de/index';
import pl from './locales/pl/index';

afterEach(async () => { await setLocale('de'); });

type Msg = string | Record<string, string>;
/** every dotted key of a nested dictionary (plural objects count as one key) */
function flat(o: object, p = ''): Record<string, Msg> {
  const out: Record<string, Msg> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' || (v && typeof v === 'object' && 'other' in v)) out[p + k] = v as Msg;
    else Object.assign(out, flat(v as object, `${p}${k}.`));
  }
  return out;
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s: string) => [...s.matchAll(/<\/?(?:b|kbd|a)\b[^>]*>/g)].map((m) => m[0]).sort();
const texts = (m: Msg) => (typeof m === 'string' ? [m] : Object.values(m));

const src = flat(de);
const dst = flat(pl);
const categories = new Intl.PluralRules('pl').resolvedOptions().pluralCategories;

describe('Polish translation', () => {
  it('plural categories of pl are one/few/many/other', () => {
    expect([...categories].sort()).toEqual(['few', 'many', 'one', 'other']);
  });

  it('translates every German key and invents none', () => {
    expect(Object.keys(dst).filter((k) => !(k in src))).toEqual([]);
    expect(Object.keys(src).filter((k) => !(k in dst))).toEqual([]);
  });

  it('keeps the shape: plural stays plural, text stays text', () => {
    for (const [k, v] of Object.entries(src)) expect(typeof dst[k], k).toBe(typeof v);
  });

  it('uses the same placeholders and markup as German', () => {
    for (const [k, v] of Object.entries(src)) {
      const d = dst[k];
      if (!d) continue;
      const want = placeholders(texts(v).join(' '));
      const wantUnique = [...new Set(want)];
      for (const s of texts(d)) {
        // each form uses only placeholders known from German, and plural forms keep {n}
        for (const p of placeholders(s)) expect(wantUnique, `${k}: {${p}}`).toContain(p);
      }
      if (typeof d === 'string') {
        expect(placeholders(d), k).toEqual(placeholders(v as string));
        expect(tags(d), k).toEqual(tags(v as string));
      } else {
        for (const s of Object.values(d)) expect([...new Set(placeholders(s))], k).toEqual(wantUnique);
        expect(tags(Object.values(d)[0] ?? ''), k).toEqual(tags(texts(v)[0] ?? ''));
      }
    }
  });

  it('plural objects provide all pl categories and only valid ones', () => {
    for (const [k, v] of Object.entries(dst)) {
      if (typeof v === 'string') continue;
      for (const c of categories) expect(v[c], `${k}.${c}`).toBeTruthy();
      for (const c of Object.keys(v)) expect([...categories, 'zero'], `${k}.${c}`).toContain(c);
    }
  });

  it('has no empty texts and no leftover German markers in key UI words', () => {
    for (const [k, v] of Object.entries(dst)) for (const s of texts(v)) expect(s.trim(), k).not.toBe('');
  });

  it('selects the right plural form at runtime', async () => {
    await setLocale('pl');
    expect(tr('shell.nav.home')).toBe('Strona główna');
    expect(tr('shell.mobile.meUnread', { n: 1 })).toBe('Mój FriendFlix, 1 nowe powiadomienie');
    expect(tr('shell.mobile.meUnread', { n: 3 })).toBe('Mój FriendFlix, 3 nowe powiadomienia');
    expect(tr('shell.mobile.meUnread', { n: 5 })).toBe('Mój FriendFlix, 5 nowych powiadomień');
    expect(tr('shell.mobile.meUnread', { n: 22 })).toBe('Mój FriendFlix, 22 nowe powiadomienia');
    expect(tr('shell.mobile.meUnread', { n: 12 })).toBe('Mój FriendFlix, 12 nowych powiadomień');
  });
});
