// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { writable } from 'svelte/store';
import type { Item } from '#lib/api';

/** The title shown in the phone preview sheet (mounted once in +layout.svelte); null = closed. */
export const previewSheet = writable<{ item: Item; opener?: HTMLElement | null } | null>(null);
export const openPreview = (item: Item, opener?: HTMLElement | null) => previewSheet.set({ item, opener });
export const closePreview = () => previewSheet.set(null);
