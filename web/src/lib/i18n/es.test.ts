// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import de from './locales/de/index';
import es from './locales/es/index';

type Leaf = string | Record<string, string>;

/** every dotted key of a nested dictionary; plural objects ({ other: … }) count as one leaf */
function flatten(o: object, p = '', out: Record<string, Leaf> = {}): Record<string, Leaf> {
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string') out[p + k] = v;
    else if (v && typeof v === 'object' && 'other' in v) out[p + k] = v as Record<string, string>;
    else if (v && typeof v === 'object') flatten(v, `${p}${k}.`, out);
  }
  return out;
}

const texts = (v: Leaf): string[] => (typeof v === 'string' ? [v] : Object.values(v));
const placeholders = (s: string): string[] => [...new Set(s.match(/\{[a-zA-Z0-9_]+\}/g) ?? [])].sort();
const tags = (s: string): string[] => (s.match(/<\/?(b|kbd|a)\b[^>]*>/g) ?? []).sort();
const phOf = (v: Leaf): string[] => [...new Set(texts(v).flatMap(placeholders))].sort();

const src = flatten(de);
const tr = flatten(es);
const categories = new Set(new Intl.PluralRules('es').resolvedOptions().pluralCategories);

describe('Spanish dictionary', () => {
  it('translates every German key and invents none', () => {
    expect(Object.keys(tr).sort()).toEqual(Object.keys(src).sort());
  });

  it('keeps the message shape (string vs. plural forms)', () => {
    for (const [k, v] of Object.entries(src)) expect(typeof tr[k], k).toBe(typeof v);
  });

  it('uses the same placeholders as German', () => {
    for (const [k, v] of Object.entries(src)) {
      const got = tr[k];
      if (typeof v === 'string') expect(placeholders(got as string), k).toEqual(placeholders(v));
      else for (const form of texts(got)) expect(placeholders(form).every((p) => phOf(v).includes(p)) && phOf(v).every((p) => placeholders(form).includes(p)), `${k}: ${form}`).toBe(true);
    }
  });

  it('keeps the allowed markup (<b>, <kbd>, <a>) intact', () => {
    for (const [k, v] of Object.entries(src)) {
      if (typeof v !== 'string') continue;
      expect(tags(tr[k] as string), k).toEqual(tags(v));
    }
  });

  it('uses valid plural categories and always provides `other`, `one` and Intl’s categories', () => {
    for (const [k, v] of Object.entries(tr)) {
      if (typeof v === 'string') continue;
      expect(typeof v.other, k).toBe('string');
      for (const c of Object.keys(v)) expect(c === 'zero' || categories.has(c as Intl.LDMLPluralRule), `${k}: ${c}`).toBe(true);
      for (const c of categories) expect(v[c], `${k}: missing ${c}`).toBeTypeOf('string');
    }
  });

  it('has no empty texts and no German leftovers in the UI-critical words', () => {
    for (const [k, v] of Object.entries(tr)) for (const s of texts(v)) expect(s.trim().length, k).toBeGreaterThan(0);
    expect((es.shell as { nav: { home: string; series: string; movies: string; new: string; myList: string } }).nav).toMatchObject({
      home: 'Inicio', series: 'Series', movies: 'Películas', new: 'Novedades y próximamente', myList: 'Guardados',
    });
  });
});
