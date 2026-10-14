// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** true when the person asked for less motion (OS setting); Svelte JS transitions use it to drop their duration. */
export const reducedMotion = (): boolean => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** transition duration that respects reduced motion */
export const dur = (ms: number): number => (reducedMotion() ? 0 : ms);
