// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Item } from '#lib/api';
import type { Prefs } from '#lib/stores';

/** Unwatched, unstarted episode while spoiler protection is on. */
export const isSpoiler = (item: Pick<Item, 'type' | 'played' | 'positionTicks'>, p: Pick<Prefs, 'spoilerProtection'>) =>
  Boolean(p.spoilerProtection) && item.type === 'Episode' && !item.played && !item.positionTicks;
