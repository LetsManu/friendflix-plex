/**
 * App-wide toasts (docs/ui-kit.md). One <ToastHost/> in the root layout renders them; call from anywhere:
 *
 *   toast.success(tr('ui.saved'));
 *   toast.error(errorText(e), { action: { label: tr('ui.retry'), run: save } });
 *   toast.info(msg, { duration: 0 });   // stays until closed
 *
 * At most MAX_VISIBLE toasts are shown; a new one pushes the oldest out (its onClose runs with reason 'replaced').
 * Timers pause while the pointer or focus is on a toast (host calls pause/resume).
 */
import { writable, type Readable } from 'svelte/store';

export type ToastKind = 'success' | 'error' | 'info';
/** why a toast went away: timeout, the × button, its action button, pushed out by a newer one, or dismissAll() */
export type CloseReason = 'timeout' | 'dismiss' | 'action' | 'replaced';

export interface ToastAction {
  label: string;
  /** called once; the toast closes with reason 'action' */
  run: () => unknown;
}
export interface ToastOptions {
  /** ms until auto-dismiss; 0 = sticky. Default: 5 s (success/info), 8 s (error), 6 s with an action */
  duration?: number;
  action?: ToastAction;
  /** called exactly once when the toast leaves */
  onClose?: (reason: CloseReason) => void;
  /** replaces a visible toast with the same key instead of stacking (e.g. repeated "saved") */
  key?: string;
}
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  duration: number;
  key?: string;
}

export const MAX_VISIBLE = 3;
export const DURATION: Record<ToastKind, number> = { success: 5000, info: 5000, error: 8000 };
export const ACTION_DURATION = 6000;

interface Entry extends Toast { onClose?: (r: CloseReason) => void; timer: ReturnType<typeof setTimeout> | null; left: number; started: number }

const list = writable<Toast[]>([]);
let entries: Entry[] = [];
let seq = 0;
const publish = () => list.set(entries.map(({ id, kind, message, action, duration, key }) => ({ id, kind, message, action, duration, key })));

function arm(e: Entry) {
  if (!e.duration || e.left <= 0) return;
  e.started = Date.now();
  e.timer = setTimeout(() => close(e.id, 'timeout'), e.left);
}

/** Shows a toast; returns its id (for dismiss). */
export function show(kind: ToastKind, message: string, opts: ToastOptions = {}): number {
  if (opts.key) { const old = entries.find((x) => x.key === opts.key); if (old) close(old.id, 'replaced'); }
  const duration = opts.duration ?? (opts.action ? ACTION_DURATION : DURATION[kind]);
  const e: Entry = { id: ++seq, kind, message, action: opts.action, duration, key: opts.key, onClose: opts.onClose, timer: null, left: duration, started: 0 };
  entries = [...entries, e];
  while (entries.length > MAX_VISIBLE) close(entries[0]!.id, 'replaced');
  arm(e);
  publish();
  return e.id;
}

/** Removes a toast (no-op when it is already gone). */
export function close(id: number, reason: CloseReason = 'dismiss'): void {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  if (e.timer) clearTimeout(e.timer);
  entries = entries.filter((x) => x !== e);
  publish();
  try { e.onClose?.(reason); } catch { /* a callback must not break the queue */ }
}

/** Runs the toast's action, then closes it with reason 'action'. */
export function runToastAction(id: number): void {
  const e = entries.find((x) => x.id === id);
  if (!e?.action) return;
  const run = e.action.run;
  close(id, 'action');
  void Promise.resolve().then(run).catch(() => undefined);
}

/** Pauses all timers (pointer/focus inside the toast region). */
export function pause(): void {
  for (const e of entries) if (e.timer) { clearTimeout(e.timer); e.timer = null; e.left = Math.max(0, e.left - (Date.now() - e.started)); }
}
/** Resumes paused timers (a toast never closes in less than 1.5 s after resuming). */
export function resume(): void {
  for (const e of entries) if (!e.timer && e.duration) { e.left = Math.max(e.left, 1500); arm(e); }
}
export function dismissAll(): void { for (const e of [...entries]) close(e.id, 'replaced'); }

/** visible toasts, oldest first */
export const toasts: Readable<Toast[]> = { subscribe: list.subscribe };

export const toast = {
  success: (message: string, opts?: ToastOptions) => show('success', message, opts),
  error: (message: string, opts?: ToastOptions) => show('error', message, opts),
  info: (message: string, opts?: ToastOptions) => show('info', message, opts),
  show,
  close,
};
