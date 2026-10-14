// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ageText, byType, moodTags, remainingLabel } from './format';

const T = 600_000_000;
describe('moodTags', () => {
  it('maps genres to moods (max 3, distinct)', () => {
    expect(moodTags(['Thriller', 'Krimi', 'Drama', 'Horror'])).toEqual(['Spannend', 'Emotional', 'Gruselig']);
    expect(moodTags(['Komödie', 'Romanze'])).toEqual(['Witzig', 'Romantisch']);
  });
  it('ignores unknown genres and handles empty input', () => {
    expect(moodTags(['Foo'])).toEqual([]);
    expect(moodTags(undefined)).toEqual([]);
  });
});
describe('remainingLabel', () => {
  it('shows the remaining time of a started title', () => {
    expect(remainingLabel(77 * T, 100 * T)).toBe('Noch 23 Min.');
    expect(remainingLabel(10 * T, 130 * T)).toBe('Noch 2 Std.');
    expect(remainingLabel(10 * T, 100 * T + 5 * T)).toBe('Noch 1 Std. 35 Min.');
  });
  it('is empty when not started, finished or unknown', () => {
    expect(remainingLabel(0, 100 * T)).toBe('');
    expect(remainingLabel(100 * T, 100 * T)).toBe('');
    expect(remainingLabel(5 * T, undefined)).toBe('');
  });
});
describe('byType', () => {
  it('filters credits by type and removes duplicates', () => {
    const p = [{ id: '1', name: 'A', type: 'Director', image: false }, { id: '2', name: 'B', type: 'Actor', image: false }, { id: '2', name: 'B', type: 'Actor', image: false }];
    expect(byType(p, 'Actor').map((x) => x.name)).toEqual(['B']);
    expect(byType(p, 'Writer')).toEqual([]);
  });
});
describe('ageText', () => {
  it('derives a sentence from the rating', () => {
    expect(ageText('FSK 12')).toBe('Ab 12 Jahren');
    expect(ageText('FSK 0')).toBe('Für alle Altersstufen freigegeben');
    expect(ageText('')).toBe('');
    expect(ageText('NR')).toBe('');
  });
});
