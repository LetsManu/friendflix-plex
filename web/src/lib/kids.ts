// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { writable } from 'svelte/store';
import { readHint } from '#lib/gate';

/**
 * True while the active profile is a kids profile. The root layout keeps it in sync with /api/me (and the boot hint until
 * that answer arrives); components hide every social entry point with it (reactions, friends, star ratings, shared lists,
 * comments, watch party, recommendations). The server enforces the same with 403 kids_profile, this only keeps the UI clean.
 */
export const kidsMode = writable<boolean>(typeof location !== 'undefined' && Boolean(readHint()?.kids));
