import { describe, expect, it } from 'vitest';
import de from './locales/de/index';
import it_ from './locales/it/index';

type Leaf = string | { other: string; [k: string]: string };
const isPlural = (v: unknown): v is Record<string, string> => !!v && typeof v === 'object' && 'other' in v;

/** every dotted key of a nested dictionary (plural objects count as one key) */
function flat(o: object, p = '', out: Record<string, Leaf> = {}): Record<string, Leaf> {
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' || isPlural(v)) out[p + k] = v as Leaf;
    else flat(v as object, `${p}${k}.`, out);
  }
  return out;
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (s: string) => [...s.matchAll(/<\/?(b|kbd|a)\b[^>]*>/g)].map((m) => m[0]).sort();
const texts = (v: Leaf) => (typeof v === 'string' ? [v] : Object.values(v));

const src = flat(de);
const dst = flat(it_);
const cats = new Set(new Intl.PluralRules('it').resolvedOptions().pluralCategories);

describe('Italian translation', () => {
  it('translates every German key and nothing else', () => {
    expect(Object.keys(dst).sort()).toEqual(Object.keys(src).sort());
  });
  it('keeps the shape (plain vs plural)', () => {
    for (const [k, v] of Object.entries(src)) expect(isPlural(dst[k]), k).toBe(isPlural(v));
  });
  it('keeps placeholders in every form', () => {
    for (const [k, v] of Object.entries(src)) {
      const want = placeholders(texts(v).join(' ') && (typeof v === 'string' ? v : v.other));
      for (const form of texts(dst[k])) {
        // a plural form may omit {n} (e.g. "one") but may not invent or drop other placeholders
        const got = placeholders(form).filter((p) => p !== 'n');
        expect(got, k).toEqual(want.filter((p) => p !== 'n'));
      }
    }
  });
  it('keeps allowed markup', () => {
    for (const [k, v] of Object.entries(src)) {
      const want = tags(typeof v === 'string' ? v : v.other);
      for (const form of texts(dst[k])) expect(tags(form), k).toEqual(want);
    }
  });
  it('uses only valid plural categories and provides all of them', () => {
    for (const [k, v] of Object.entries(dst)) {
      if (!isPlural(v)) continue;
      for (const c of Object.keys(v)) expect(c === 'zero' || cats.has(c as Intl.LDMLPluralRule), `${k}.${c}`).toBe(true);
      for (const c of cats) expect(v[c], `${k} lacks "${c}"`).toBeTypeOf('string');
    }
  });
  it('has no empty texts', () => {
    for (const [k, v] of Object.entries(dst)) for (const s of texts(v)) expect(s.trim().length, k).toBeGreaterThan(0);
  });
});
