import { describe, expect, it } from 'vitest';
import de from './locales/de/index';
import tr from './locales/tr/index';

type Leaf = string | Record<string, string>;
const isPlural = (v: unknown): v is Record<string, string> => !!v && typeof v === 'object' && 'other' in (v as object);

/** every dotted key of a nested dictionary (plural objects count as one key) */
function flat(o: object, p = '', out: Record<string, Leaf> = {}): Record<string, Leaf> {
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' || isPlural(v)) out[p + k] = v as Leaf;
    else flat(v as object, `${p}${k}.`, out);
  }
  return out;
}
const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();
const tags = (s: string) => [...s.matchAll(/<\/?(b|kbd|a)\b[^>]*>/g)].map((m) => m[0]).sort();

const deFlat = flat(de);
const trFlat = flat(tr);
const categories = new Set(new Intl.PluralRules('tr').resolvedOptions().pluralCategories as string[]);

describe('Turkish dictionary', () => {
  it('has exactly the German keys', () => {
    expect(Object.keys(trFlat).sort()).toEqual(Object.keys(deFlat).sort());
  });

  it('keeps placeholders and allowed markup of the German source', () => {
    for (const [key, src] of Object.entries(deFlat)) {
      const dst = trFlat[key]!;
      const srcText = typeof src === 'string' ? src : src.other!;
      const forms = typeof dst === 'string' ? [dst] : Object.values(dst);
      for (const text of forms) {
        expect(placeholders(text), key).toEqual(placeholders(srcText));
        expect(tags(text), key).toEqual(tags(srcText));
      }
    }
  });

  it('uses plural objects exactly where German does, with valid categories', () => {
    for (const [key, src] of Object.entries(deFlat)) {
      const dst = trFlat[key]!;
      expect(isPlural(dst), key).toBe(isPlural(src));
      if (!isPlural(dst)) continue;
      expect(dst.other, key).toBeTruthy();
      for (const c of Object.keys(dst)) expect(categories.has(c) || c === 'zero', `${key}.${c}`).toBe(true);
      for (const c of categories) expect(dst[c], `${key}.${c}`).toBeTruthy();
    }
  });

  it('has no empty texts', () => {
    for (const [key, v] of Object.entries(trFlat)) {
      for (const text of typeof v === 'string' ? [v] : Object.values(v)) expect(text.trim(), key).not.toBe('');
    }
  });
});
