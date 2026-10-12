import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '#lib/i18n';
import de from '#lib/i18n/locales/de/index';
import en from '#lib/i18n/locales/en/index';
import { lengthLabel, ratingBadge, fmtRuntime } from '#lib/hover';
import { NEW_TABS, releaseLabel, runtimeLabel, shareData } from '#lib/mobile';
import { activeChips, parseBrowse } from '#lib/discovery';
import { langLine } from '#lib/langs';
import { roleLabel } from '#lib/lists';
import { ageText, moodTags, remainingLabel, seasonLabel } from './format';
import { countdownLabel } from './autostart';

afterEach(async () => { await setLocale('de'); });

const keys = (o: object, p = ''): string[] =>
  Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' || (v && typeof v === 'object' && 'other' in v) ? [p + k] : keys(v as object, `${p}${k}.`)));
const T = 600_000_000;

describe('areas home + detail', () => {
  it('English covers every key', () => {
    for (const area of ['home', 'detail'] as const) expect(keys(en[area] ?? {}), area).toEqual(keys(de[area]));
    expect(keys(de.home).length).toBeGreaterThan(150);
  });

  it('German helpers (default locale)', () => {
    expect(langLine({ audio: ['deu', 'eng'], subs: ['ger'] })).toBe('Ton: Deutsch, Englisch · Untertitel: Deutsch');
    expect(remainingLabel(30 * T, 53 * T)).toBe('Noch 23 Min.');
    expect(remainingLabel(0, 53 * T)).toBe('');
    expect(countdownLabel('movie', 4.2)).toBe('Film startet in 5 …');
    expect(moodTags(['Thriller', 'Comedy', 'Krimi'])).toEqual(['Spannend', 'Witzig']);
    expect(ageText('FSK 12')).toBe('Ab 12 Jahren');
    expect(seasonLabel({ name: '', indexNumber: 2 })).toBe('Staffel 2');
    expect(roleLabel.owner).toBe('Besitzer');
    expect(NEW_TABS.map(([id]) => id)).toEqual(['soon', 'week', 'added']);
  });

  it('helpers follow the UI language', async () => {
    await setLocale('en');
    expect(fmtRuntime(112 * T)).toBe('1 h 52 min');
    expect(lengthLabel({ type: 'Series', childCount: 1 })).toBe('1 season');
    expect(lengthLabel({ type: 'Series', childCount: 3 })).toBe('3 seasons');
    expect(lengthLabel({ type: 'BoxSet', childCount: 4 })).toBe('4 titles');
    expect(ratingBadge({ communityRating: 8.8, year: 2010 }, Date.now())).toBe('★ 8.8');
    expect(runtimeLabel({ type: 'Series' })).toBe('Series');
    expect(releaseLabel('2026-03-05T00:00:00Z')).toBe('Releases on 5 March 2026');
    expect(releaseLabel(undefined)).toBe('Date to be announced');
    expect(shareData({ id: 'm1', name: 'Dunmoor', type: 'Movie' }, 'https://x.test').text).toBe('Dunmoor on FriendFlix');
    expect(langLine({ audio: ['deu'], subs: ['eng'] })).toBe('Audio: German · Subtitles: English');
    expect(remainingLabel(30 * T, 53 * T)).toBe('23 min left');
    expect(countdownLabel('episode', 3)).toBe('Episode starts in 3 …');
    expect(moodTags(['Drama', 'Horror'])).toEqual(['Emotional', 'Scary']);
    expect(ageText('FSK 0')).toBe('Suitable for all ages');
    expect(roleLabel.viewer).toBe('Reader');
    const chips = activeChips(parseBrowse(new URLSearchParams('decade=1990&minRating=7&audio=deu&filter=played')));
    expect(chips.map((c) => c.label)).toEqual(['1990s', '7+ stars', 'Audio: German', 'Watched']);
  });
});
