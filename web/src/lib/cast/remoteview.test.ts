// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { tr } from '#lib/i18n';
import { castBackdrops, castThumbs, deviceLabel, episodeLabel, episodeLine, playingLine } from './remoteview';

const ep = { itemId: 'e1', seriesId: 's1', isEpisode: true };
const film = { itemId: 'f1', isEpisode: false };

describe('cast remote screen', () => {
  it('background: episode still, series backdrop, series poster; film: backdrop, poster (portal image path only)', () => {
    expect(castBackdrops(ep)).toEqual([
      '/media/Items/e1/Images/Primary?maxWidth=1280&quality=85',
      '/media/Items/s1/Images/Backdrop?maxWidth=1280&quality=80',
      '/media/Items/s1/Images/Primary?maxWidth=640&quality=85',
    ]);
    expect(castBackdrops({ itemId: 'e2', isEpisode: true })).toEqual(['/media/Items/e2/Images/Primary?maxWidth=1280&quality=85']);
    expect(castBackdrops(film)).toEqual(['/media/Items/f1/Images/Backdrop?maxWidth=1280&quality=80', '/media/Items/f1/Images/Primary?maxWidth=640&quality=85']);
    for (const u of [...castBackdrops(ep), ...castThumbs(film)]) expect(u).not.toMatch(/api_key|ApiKey|\/media\/c\//);
  });

  it('thumbnail: 16:9 sources first', () => {
    expect(castThumbs(ep)).toEqual(['/media/Items/e1/Images/Primary?maxWidth=640&quality=85', '/media/Items/s1/Images/Backdrop?maxWidth=640&quality=80']);
    expect(castThumbs(film)[0]).toContain('/f1/Images/Backdrop');
  });

  it('device: AirPlay has no name, Chromecast shows the receiver', () => {
    expect(deviceLabel({ kind: 'airplay', device: 'AirPlay-Gerät' })).toBe('AirPlay');
    expect(deviceLabel({ kind: 'chromecast', device: 'Wohnzimmer-TV' })).toBe('Wohnzimmer-TV');
    expect(deviceLabel({ kind: 'chromecast', device: '' })).toBe('Chromecast');
    expect(playingLine({ kind: 'airplay', device: 'x' }, tr)).toBe('Läuft über AirPlay');
    expect(playingLine({ kind: 'chromecast', device: 'Wohnzimmer-TV' }, tr)).toBe('Wird auf Wohnzimmer-TV abgespielt');
  });

  it('episode line: the header\'s "S1:E1 · Name" format, the session subtitle as the fallback', () => {
    expect(episodeLabel({ name: 'Folge 1', parentIndexNumber: 1, indexNumber: 1 })).toBe('S1:E1 · Folge 1');
    expect(episodeLabel({ name: 'Special' })).toBe('Special');
    expect(episodeLine({ isEpisode: true, subtitle: 'S1:F1 Folge 1' }, { name: 'Folge 1', parentIndexNumber: 1, indexNumber: 1 })).toBe('S1:E1 · Folge 1');
    expect(episodeLine({ isEpisode: true, subtitle: 'S1:F1 Folge 1' }, undefined)).toBe('S1:F1 Folge 1');
    expect(episodeLine({ isEpisode: false, subtitle: '' }, { name: 'Film' })).toBe('');
  });
});
