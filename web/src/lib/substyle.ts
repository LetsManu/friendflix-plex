// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SubtitleStyle } from '#lib/stores';
import type { TKey } from '#lib/i18n';

/** option values → i18n keys (render with $t) */
export const SIZE_LABELS: Record<SubtitleStyle['size'], TKey> = { s: 'account.settings.sizes.s', m: 'account.settings.sizes.m', l: 'account.settings.sizes.l', xl: 'account.settings.sizes.xl' };
export const COLOR_LABELS: Record<SubtitleStyle['color'], TKey> = { white: 'account.settings.colors.white', yellow: 'account.settings.colors.yellow', cyan: 'account.settings.colors.cyan', green: 'account.settings.colors.green' };
export const BG_LABELS: Record<SubtitleStyle['background'], TKey> = { none: 'account.settings.backgrounds.none', shadow: 'account.settings.backgrounds.shadow', semi: 'account.settings.backgrounds.semi', solid: 'account.settings.backgrounds.solid' };
export const FONT_LABELS: Record<SubtitleStyle['font'], TKey> = { sans: 'account.settings.fonts.sans', serif: 'account.settings.fonts.serif', mono: 'account.settings.fonts.mono' };

/** Classes for the stage / preview element; the matching static CSS rules live in Player.svelte and the settings page. */
export const subClasses = (s: SubtitleStyle) => `sub-size-${s.size} sub-color-${s.color} sub-bg-${s.background} sub-font-${s.font}`;
