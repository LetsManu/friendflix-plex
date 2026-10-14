// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { pushState, replaceState } from '$app/navigation';

/** Opens the detail popup over the current page (shallow routing: URL changes, page does not reload). */
export function openModal(e: MouseEvent, href: string) {
  // let ctrl/cmd/middle clicks open the real page in a new tab
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  const id = href.split('/').pop()!;
  pushState(href, { modalId: id });
}

/** Switches the open popup to another title without adding a history entry (the close button still closes it in one step). */
export function swapModal(href: string) {
  const id = href.split('/').pop()!;
  replaceState(href, { modalId: id });
}
