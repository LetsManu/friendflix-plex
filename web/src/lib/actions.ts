// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Svelte action: focuses (and selects) the element when it appears. */
export function autofocus(node: HTMLElement) {
  queueMicrotask(() => { node.focus(); if (node instanceof HTMLInputElement) node.select(); });
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Svelte action for dialogs and sheets: Escape calls `close`, Tab stays inside the node.
 * Focus the first control yourself (or pass `focusFirst`) and restore it in `close`.
 */
export function dialogKeys(node: HTMLElement, opts: { close: () => void; focusFirst?: boolean }) {
  let o = opts;
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); o.close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0]!, last = f[f.length - 1]!, a = document.activeElement;
    if (!node.contains(a)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
  }
  node.addEventListener('keydown', onKey);
  if (o.focusFirst) queueMicrotask(() => node.querySelector<HTMLElement>(FOCUSABLE)?.focus());
  return { update(n: typeof opts) { o = n; }, destroy() { node.removeEventListener('keydown', onKey); } };
}
