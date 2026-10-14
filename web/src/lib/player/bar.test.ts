// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { barTitles, firstInfoBody, speedLabel } from './bar';
import { setLocale } from '#lib/i18n';

describe('firstInfoBody', () => {
  it('sends saved quality and audio language, the detail-page pick wins', () => {
    expect(firstInfoBody({ quality: 4_000_000, audioLang: 'ger' })).toEqual({ maxBitrate: 4_000_000, audioLang: 'ger' });
    expect(firstInfoBody({ quality: 0, audioLang: 'ger' }, 'eng')).toEqual({ audioLang: 'eng' });
    expect(firstInfoBody({ quality: 0, audioLang: '' })).toEqual({});
    expect(firstInfoBody({ quality: 10 })).toEqual({}); // below the server minimum: auto
  });
});

describe('barTitles', () => {
  it('formats episodes and films', () => {
    expect(barTitles({ name: 'Pilot', seriesName: 'Bright Valley', indexNumber: 1, parentIndexNumber: 1 })).toEqual({ title: 'Bright Valley', sub: 'S1:F1 Pilot' });
    expect(barTitles({ name: 'Pilot', seriesName: 'Bright Valley', indexNumber: 3 })).toEqual({ title: 'Bright Valley', sub: 'F3 Pilot' });
    expect(barTitles({ name: 'Inkwell', type: 'Movie' })).toEqual({ title: 'Inkwell', sub: '' });
    expect(barTitles(null)).toEqual({ title: '', sub: '' });
  });
  it('uses the episode code of the UI language (no German "F" in English)', async () => {
    await setLocale('en');
    try {
      expect(barTitles({ name: 'Pilot', seriesName: 'Bright Valley', indexNumber: 1, parentIndexNumber: 2 }).sub).toBe('S2:E1 Pilot');
      expect(barTitles({ name: 'Pilot', seriesName: 'Bright Valley', indexNumber: 4 }).sub).toBe('E4 Pilot');
    } finally { await setLocale('de'); }
  });
  it('speed labels', () => {
    expect(speedLabel(1)).toBe('1× (Normal)');
    expect(speedLabel(1.25)).toBe('1,25×');
  });
});
