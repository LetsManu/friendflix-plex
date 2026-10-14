// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * runAction: one helper for every mutation in the UI (docs/ui-kit.md).
 *
 *   await runAction({
 *     key: `user:${u.id}`,                                   // per-row busy flag ($busyKeys.has(key)); double clicks are ignored
 *     apply: () => { const prev = u.role; u.role = role; users = users; return () => { u.role = prev; users = users; }; },
 *     run: () => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { role } }),
 *     success: tr('…saved'),                                 // toast (string or (result) => string)
 *     undo: { run: () => api(…inverse…) },                   // optional: Undo button in the success toast
 *   });
 *
 * Order: busy on → apply() (optimistic) → run() → success toast | rollback + error toast → busy off.
 * `defer: true` (delay-commit): apply() → toast with Undo → run() only after the toast is gone; Undo just rolls back.
 * Use it for one-way actions that are cheap to postpone (decline a request, revoke an invite).
 * Waiting deferred actions are never lost: leaving the page (other route, reload, tab close → `flushDeferred()` from the
 * root layout's beforeNavigate and a `pagehide` listener) commits them at once, with keepalive requests on unload.
 */
import { writable, type Readable } from 'svelte/store';
import { ApiError, keepaliveDuring } from '#lib/api';
import { tr } from '#lib/i18n';
import { ACTION_DURATION, toast } from './toast';

export interface UndoSpec {
  /** inverse call (immediate mode); not needed with `defer` */
  run?: () => unknown;
  /** button text, default tr('ui.undo') */
  label?: string;
}
export interface ActionOptions<T> {
  /** busy flag; while set, a second call with the same key is skipped */
  key?: string;
  /** optimistic local change; return the rollback */
  apply?: () => (() => void) | void;
  run: () => Promise<T>;
  success?: string | ((r: T | undefined) => string);
  /** false = no error toast (caller handles it); default errorText(e) */
  error?: string | false | ((e: unknown) => string);
  undo?: UndoSpec;
  /** delay-commit: true or the delay in ms (default ACTION_DURATION) */
  defer?: boolean | number;
}
export interface ActionResult<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
  /** the person pressed Undo */
  undone?: boolean;
  /** skipped because the key was busy */
  skipped?: boolean;
}

const keys = writable<ReadonlySet<string>>(new Set());
let cur = new Set<string>();
const setBusy = (k: string | undefined, on: boolean) => {
  if (!k) return;
  cur = new Set(cur);
  if (on) cur.add(k); else cur.delete(k);
  keys.set(cur);
};
/** keys of running actions: `$busyKeys.has('user:1')` */
export const busyKeys: Readable<ReadonlySet<string>> = { subscribe: keys.subscribe };
export const isBusy = (k: string): boolean => cur.has(k);

/** Localised text for a failed request (status-aware). */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return tr('ui.error.forbidden');
    if (e.status === 404) return tr('ui.error.notFound');
    if (e.status === 409) return tr('ui.error.conflict');
    if (e.status === 429) return tr('ui.error.tooMany');
    if (e.status >= 500) return tr('ui.error.server');
    return tr('ui.error.generic');
  }
  if (e instanceof TypeError) return tr('ui.error.network'); // fetch() rejects with TypeError when offline
  return tr('ui.error.generic');
}

/** deferred actions whose toast is still up; commit(unloading) runs them now */
const waiting = new Set<{ commit: (unloading: boolean) => void }>();
let hooked = false;
function hookPagehide() {
  if (hooked || typeof window === 'undefined') return;
  hooked = true;
  window.addEventListener('pagehide', () => flushDeferred(true));
}
/**
 * Commits every waiting deferred action immediately (their Undo toasts close). `unloading`: the document goes away,
 * so requests are sent with keepalive. Returns how many were committed.
 */
export function flushDeferred(unloading = false): number {
  const all = [...waiting];
  for (const w of all) w.commit(unloading);
  return all.length;
}
/** pending deferred actions (tests, diagnostics) */
export const deferredCount = (): number => waiting.size;

/** calls fn now (synchronously, so keepalive applies) and turns a throw into a rejection */
const start = <T>(fn: () => Promise<T>): Promise<T> => { try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); } };

const text = <A>(v: string | ((a: A) => string) | undefined, a: A): string | undefined => (typeof v === 'function' ? v(a) : v);

export async function runAction<T>(o: ActionOptions<T>): Promise<ActionResult<T>> {
  if (o.key && cur.has(o.key)) return { ok: false, skipped: true };
  const fail = (e: unknown, rollback: (() => void) | void): ActionResult<T> => {
    try { rollback?.(); } catch { /* ignore */ }
    if (o.error !== false) toast.error(typeof o.error === 'string' ? o.error : typeof o.error === 'function' ? o.error(e) : errorText(e));
    return { ok: false, error: e };
  };

  if (o.defer) {
    setBusy(o.key, true);
    hookPagehide();
    const rollback = o.apply?.();
    const outcome = await new Promise<{ undo: true } | { undo: false; running: Promise<T> }>((resolve) => {
      let settled = false, id = 0;
      const w = {
        commit: (unloading: boolean) => {
          if (settled) return;
          settled = true;
          waiting.delete(w);
          resolve({ undo: false, running: unloading ? keepaliveDuring(() => start(o.run)) : start(o.run) });
          toast.close(id);
        },
      };
      waiting.add(w);
      id = toast.info(text(o.success, undefined) ?? tr('ui.done'), {
        duration: typeof o.defer === 'number' ? o.defer : ACTION_DURATION,
        action: { label: o.undo?.label ?? tr('ui.undo'), run: () => undefined },
        onClose: (reason) => {
          if (settled) return;
          if (reason === 'action') { settled = true; waiting.delete(w); resolve({ undo: true }); } else w.commit(false);
        },
      });
    });
    if (outcome.undo) { try { rollback?.(); } catch { /* ignore */ } setBusy(o.key, false); return { ok: false, undone: true }; }
    try { const value = await outcome.running; return { ok: true, value }; } catch (e) { return fail(e, rollback); } finally { setBusy(o.key, false); }
  }

  setBusy(o.key, true);
  let rollback: (() => void) | void = undefined;
  try {
    rollback = o.apply?.();
    const value = await o.run();
    const msg = text(o.success, value);
    const undo = o.undo?.run;
    if (undo) {
      toast.success(msg ?? tr('ui.done'), {
        action: {
          label: o.undo?.label ?? tr('ui.undo'),
          run: async () => {
            if (o.key && cur.has(o.key)) return;
            setBusy(o.key, true);
            try { rollback?.(); } catch { /* ignore */ }
            try { await undo(); toast.info(tr('ui.undone')); } catch (e) { o.apply?.(); toast.error(errorText(e)); } finally { setBusy(o.key, false); }
          },
        },
      });
    } else if (msg) toast.success(msg);
    return { ok: true, value };
  } catch (e) {
    return fail(e, rollback);
  } finally {
    setBusy(o.key, false);
  }
}
