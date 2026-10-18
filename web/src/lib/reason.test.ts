// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Item } from '#lib/api';
import { LOCALES, setLocale, tr } from '#lib/i18n';
import { reasonLines, reasonText, traitText } from './reason';

const SEED = { id: 'a'.repeat(32), name: 'Dune' };
const item = (id: string, name: string, reason?: Item['reason']) => ({ id, name, type: 'Movie', genres: [], image: false, backdrop: false, logo: false, played: false, favorite: false, positionTicks: 0, ...(reason ? { reason } : {}) }) as Item;

describe('reason captions', () => {
  it('seed plus traits: "Because you watched “Dune” · same director"', async () => {
    await setLocale('en');
    expect(reasonText({ seed: SEED, traits: ['director', 'genre:Science Fiction'] }, tr)).toBe('Because you watched “Dune” · same director · genre: Science Fiction');
    expect(reasonText({ seed: SEED, traits: ['director:Denis V.'] }, tr)).toBe('Because you watched “Dune” · same director (Denis V.)');
    expect(reasonText({ seed: null, traits: ['friends:Anna, Ben'] }, tr)).toBe('Picked for you · Anna, Ben rated it');
    expect(reasonText({ seed: SEED, traits: [] }, tr)).toBe('Because you watched “Dune”');
  });
  it('unknown trait kinds are left out (a newer server), no reason gives no caption', async () => {
    await setLocale('en');
    expect(traitText('hologram:x', tr)).toBe('');
    expect(traitText('studio', tr)).toBe(''); // a studio without a name says nothing
    expect(reasonText({ seed: SEED, traits: ['hologram'] }, tr)).toBe('Because you watched “Dune”');
    expect(reasonText(undefined, tr)).toBe('');
  });
  it('lists the first items that have a reason', async () => {
    await setLocale('en');
    const items = [item('1', 'A'), item('2', 'B', { seed: SEED, traits: ['next'] }), item('3', 'C', { seed: SEED, traits: ['universe'] })];
    expect(reasonLines(items, tr, 1)).toEqual([{ id: '2', name: 'B', text: 'Because you watched “Dune” · people watch this next' }]);
    expect(reasonLines(items, tr).map((l) => l.id)).toEqual(['2', '3']);
  });
  it('every locale has every caption key (no fallback to German in the seven languages)', async () => {
    for (const { code: l } of LOCALES) {
      await setLocale(l);
      const text = reasonText({ seed: SEED, traits: ['friends:Anna', 'next', 'together', 'universe', 'director:X', 'actor:Y', 'studio:Z', 'genre:W'] }, tr);
      expect(text, l).toContain('Dune');
      expect(text.split(' · ').length, l).toBe(9);
    }
    await setLocale('en');
  });
});
