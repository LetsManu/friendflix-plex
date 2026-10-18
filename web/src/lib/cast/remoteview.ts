// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The watch page as the TV's remote: what plays there (artwork, titles, device) for the Player's cast screen.
 * Images go through the portal's own image path (`/media/Items/…`, the session cookie; never a cast or media server token).
 */
import { backdrop, img, type Item } from '#lib/api';
import type { TFn } from '#lib/i18n';
import type { CastSession } from './engine';

type Art = Pick<CastSession, 'itemId' | 'seriesId' | 'isEpisode'>;

/**
 * Background candidates, best first (the next one is tried when one fails to load): an episode's still, then the series backdrop,
 * then the series poster; a film's backdrop, then its poster.
 */
export function castBackdrops(s: Art, w = 1280): string[] {
  if (s.isEpisode) return [img(s.itemId, w), ...(s.seriesId ? [backdrop(s.seriesId, w), img(s.seriesId, Math.round(w / 2))] : [])];
  return [backdrop(s.itemId, w), img(s.itemId, Math.round(w / 2))];
}

/** 16:9 thumbnail candidates: the episode still (else the series backdrop); a film's backdrop (else its poster) */
export function castThumbs(s: Art, w = 640): string[] {
  if (s.isEpisode) return [img(s.itemId, w), ...(s.seriesId ? [backdrop(s.seriesId, w)] : [])];
  return [backdrop(s.itemId, w), img(s.itemId, w)];
}

/** the device chip's short label: AirPlay has no receiver name in WebKit; Chromecast shows the receiver's friendly name */
export const deviceLabel = (s: Pick<CastSession, 'kind' | 'device'>): string => (s.kind === 'airplay' ? 'AirPlay' : s.device || 'Chromecast');

/** the "playing on" line under the titles */
export const playingLine = (s: Pick<CastSession, 'kind' | 'device'>, tf: TFn): string =>
  s.kind === 'airplay' ? tf('player.airplay.playing') : tf('player.cast.playingOn', { name: s.device || 'Chromecast' });

/** an episode as the watch page's header and the next-episode label show it: "S1:E2 · Name" (the name alone without numbers) */
export const episodeLabel = (it: Pick<Item, 'name' | 'parentIndexNumber' | 'indexNumber'>): string =>
  (it.parentIndexNumber != null && it.indexNumber != null ? `S${it.parentIndexNumber}:E${it.indexNumber} · ${it.name}` : it.name);

/** the card's second line: the episode in that format when its item is known, else the session's subtitle */
export const episodeLine = (s: Pick<CastSession, 'isEpisode' | 'subtitle'>, it: Pick<Item, 'name' | 'parentIndexNumber' | 'indexNumber'> | null | undefined): string =>
  (s.isEpisode && it ? episodeLabel(it) : s.subtitle);
