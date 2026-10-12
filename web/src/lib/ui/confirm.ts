/**
 * Promise-based confirmation dialog (replaces window.confirm). One <ConfirmHost/> in the root layout renders it.
 *
 *   if (!(await confirm({ title: tr('…'), body: tr('…'), danger: true, confirmLabel: tr('ui.delete') }))) return;
 *   // very destructive: the person has to type a word first
 *   await confirm({ title, body, danger: true, typed: 'Anna' });
 *
 * Requests queue: a second confirm() waits until the first is answered. Without a mounted host (unit tests, SSR) it
 * resolves false, so nothing destructive runs by accident.
 */
import { writable, type Readable } from 'svelte/store';

export interface ConfirmOptions {
  title: string;
  /** plain text (no markup) under the title */
  body?: string;
  /** red confirm button, focus starts on Cancel */
  danger?: boolean;
  /** default: tr('ui.confirm.ok') / tr('ui.confirm.delete') for danger */
  confirmLabel?: string;
  cancelLabel?: string;
  /** typed confirmation: the confirm button stays disabled until this exact text (case-insensitive, trimmed) is entered */
  typed?: string;
}
export interface ConfirmRequest extends ConfirmOptions { id: number }

const cur = writable<ConfirmRequest | null>(null);
const queue: Array<{ req: ConfirmRequest; resolve: (ok: boolean) => void }> = [];
let active: { req: ConfirmRequest; resolve: (ok: boolean) => void } | null = null;
let hosts = 0, seq = 0;

function next() {
  active = queue.shift() ?? null;
  cur.set(active?.req ?? null);
}

/** Asks the person; resolves true (confirmed) or false (cancel, Escape, backdrop). */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  if (!hosts) return Promise.resolve(false);
  return new Promise((resolve) => {
    queue.push({ req: { ...opts, id: ++seq }, resolve });
    if (!active) next();
  });
}

/** Called by the host with the answer to the visible request. */
export function answer(ok: boolean): void {
  if (!active) return;
  const a = active;
  next();
  a.resolve(ok);
}

/** true when the typed confirmation matches */
export const typedOk = (want: string | undefined, got: string): boolean => !want || got.trim().toLocaleLowerCase() === want.trim().toLocaleLowerCase();

/** The host registers itself (so confirm() knows someone can answer); returns the unregister function. */
export function registerHost(): () => void {
  hosts++;
  return () => {
    hosts--;
    if (!hosts) { while (active) answer(false); }
  };
}

export const confirmRequest: Readable<ConfirmRequest | null> = { subscribe: cur.subscribe };
