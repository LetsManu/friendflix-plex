// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lazily loaded pieces of the app shell. The detail popup (ItemModal + DetailView, ~35 KB gz incl. CSS) is not part of the
 * layout chunk; it loads on first use, or earlier via prefetchModal() (hover/focus/touch of a card or an info button).
 */
type ModalModule = typeof import('#lib/ItemModal.svelte');

let modal: Promise<ModalModule> | null = null;

/** the ItemModal module (cached; a failed load is retried on the next call) */
export function loadModal(): Promise<ModalModule> {
  return (modal ??= import('#lib/ItemModal.svelte').catch((e) => { modal = null; throw e; }));
}

/** warms the ItemModal chunk without waiting for it (safe to call often) */
export function prefetchModal(): void {
  void loadModal().catch(() => undefined);
}
