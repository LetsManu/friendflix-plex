import { describe, expect, it } from 'vitest';
import { animeAudio, animeDefaultApplies, animeSubtitle } from './anime';

describe('anime original audio + subtitles', () => {
  const none = { audio: null, subtitle: null };
  it('applies only to anime without an own series choice, and only when enabled', () => {
    expect(animeDefaultApplies(true, true, none)).toBe(true);
    expect(animeDefaultApplies(false, true, none)).toBe(false);
    expect(animeDefaultApplies(true, false, none)).toBe(false);
    expect(animeDefaultApplies(true, undefined, none)).toBe(false); // older server: unknown
    expect(animeDefaultApplies(true, true, { audio: 'ger', subtitle: null })).toBe(false); // the series pref wins
    expect(animeDefaultApplies(true, true, { audio: null, subtitle: 'off' })).toBe(false);
    expect(animeAudio(true)).toBe('jpn');
    expect(animeAudio(false)).toBe('');
  });
  it('picks subtitles in the UI language when the Japanese track plays; falls back otherwise', () => {
    const subs = [{ language: 'eng' }, { language: 'deu' }, { language: 'fre' }];
    expect(animeSubtitle('de', 'jpn', subs)).toBe('deu');
    expect(animeSubtitle('en', 'jpn', subs)).toBe('eng');
    expect(animeSubtitle('fr', 'JPN', subs)).toBe('fre');
    expect(animeSubtitle('pl', 'jpn', subs)).toBeNull(); // no Polish subtitles: global default
    expect(animeSubtitle('de', 'ger', subs)).toBeNull(); // dub only (no Japanese track): no forced subtitles
    expect(animeSubtitle('de', undefined, subs)).toBeNull();
    expect(animeSubtitle('de', 'jpn', [{}])).toBeNull();
  });
});
