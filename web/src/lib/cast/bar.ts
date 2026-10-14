// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { img } from '#lib/api';
import type { TFn } from '#lib/i18n';
import type { CastSession } from './engine';

/** The cast bar shows while a title plays on a TV, except on the immersive pages (watch, party) and in TV mode. */
export function barVisible(o: { path: string; tv: boolean; session: CastSession | null }): boolean {
  return o.session !== null && !o.tv && !/^\/(watch|party)\//.test(o.path);
}

/** Second bar line: "subtitle · auf Gerät" (just "auf Gerät" for films). */
export function barLine(s: CastSession, tf: TFn): string {
  const on = tf('player.castBar.on', { device: s.device });
  return s.subtitle ? `${s.subtitle} · ${on}` : on;
}

/** Playback progress in percent (0–100); 0 while the duration is unknown. */
export function barProgress(s: CastSession): number {
  return s.duration > 0 ? Math.min(100, Math.max(0, (s.position / s.duration) * 100)) : 0;
}

/** Poster for the bar: landscape still for episodes, portrait poster for films. */
export function barThumb(s: CastSession): { src: string; ratio: '16/9' | '2/3' } {
  return { src: img(s.posterId, 160), ratio: s.isEpisode ? '16/9' : '2/3' };
}

/** Whole seconds until the next episode autoplays (rounded up, never negative); null without a countdown. */
export function nextSecondsLeft(startsAt: number | null, now: number): number | null {
  return startsAt === null ? null : Math.max(0, Math.ceil((startsAt - now) / 1000));
}
