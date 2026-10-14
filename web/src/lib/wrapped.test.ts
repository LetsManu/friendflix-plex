// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from './i18n';
import { localWeekday, weekdayName } from './wrapped';

afterEach(async () => { await setLocale('de'); });

describe('weekday names', () => {
  it('0 is Sunday, in the UI language', async () => {
    expect(weekdayName(0)).toBe('Sonntag');
    expect(weekdayName(6)).toBe('Samstag');
    await setLocale('en');
    expect(weekdayName(1)).toBe('Monday');
  });
  it('translates the German name the server sends; unknown values stay', async () => {
    await setLocale('en');
    expect(localWeekday('Mittwoch')).toBe('Wednesday');
    expect(localWeekday('Funday')).toBe('Funday');
    expect(localWeekday(null)).toBeNull();
  });
});
