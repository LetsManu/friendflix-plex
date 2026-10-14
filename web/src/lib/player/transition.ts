// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Going into the player (Block 20, spec §4): the clicked artwork morphs into the player poster (View Transitions API,
 * shared name `ff-play-art`), else a 200 ms fade; reduced motion = instant cut plus a 120 ms fade; TV = no transition.
 */

export const PLAY_ART_NAME = 'ff-play-art';
/** a marked artwork older than this belongs to a click that did not navigate */
const ART_MAX_AGE_MS = 3000;
let art: { el: HTMLElement; at: number } | null = null;

/** the play control was clicked: remember its artwork (null = none, the fade fallback applies) */
export function markPlayArt(el: HTMLElement | null): void { art = el ? { el, at: Date.now() } : null; }

/** the remembered artwork, once, when it is still in the page and (partly) on screen */
export function takePlayArt(now = Date.now()): HTMLElement | null {
  const a = art; art = null;
  if (!a || now - a.at > ART_MAX_AGE_MS || !a.el.isConnected) return null;
  const r = a.el.getBoundingClientRect();
  const onScreen = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  return onScreen ? a.el : null;
}

export type PlayTransition = 'none' | 'view' | 'fade';
/** how the layout enters/leaves /watch: 'view' = View Transition (morph when the artwork is there), 'fade' = the page fades itself in, 'none' = cut */
export function playTransition(o: { tv: boolean; reduced: boolean; hasApi: boolean }): PlayTransition {
  if (o.tv) return 'none';
  if (o.reduced || !o.hasApi) return 'fade';
  return 'view';
}

/** fade-in of the player page in ms: 0 on TV or while a view transition does the work, 120 with reduced motion, else 200 */
export function entryFadeMs(o: { tv: boolean; reduced: boolean; viewTransition: boolean }): number {
  if (o.tv || o.viewTransition) return 0;
  return o.reduced ? 120 : 200;
}
