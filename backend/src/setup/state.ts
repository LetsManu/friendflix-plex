// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type pg from 'pg';
import { audit } from '../audit.js';
import type { Config } from '../config.js';
import type { Ctx } from '../ctx.js';
import { readMeta } from '../settings/repo.js';
import { SETTINGS } from '../settings/registry.js';
import type { SettingsStore } from '../settings/store.js';

/**
 * Setup mode (spec Part E1): until settings_meta.setup_completed_at is set, the app answers 503 setup_required (app.ts) and the
 * background jobs do nothing. The answer is cached per settings store and re-read once the store's rev moves: a completion bumps the
 * rev (updateMeta), and every instance sees the new rev through the bus or its 30 s poll, so the cache costs no query per request.
 */
interface Cached { rev: number; complete: boolean }
const cache = new WeakMap<SettingsStore, Cached>();
const pending = new WeakMap<SettingsStore, Promise<boolean>>();

export async function isSetupComplete(ctx: Pick<Ctx, 'db' | 'settings'>): Promise<boolean> {
  const rev = ctx.settings.rev();
  const c = cache.get(ctx.settings);
  if (c && c.rev === rev) return c.complete;
  // one read per store at a time (a burst of requests after a rev change shares it)
  let p = pending.get(ctx.settings);
  if (!p) {
    p = readMeta(ctx.db).then((m) => {
      const complete = m.setupCompletedAt !== null;
      cache.set(ctx.settings, { rev, complete });
      return complete;
    }, (err: unknown) => {
      // the database is unavailable: keep answering the last known state (the outdated rev makes the next call retry); only a cold cache fails
      if (c) return c.complete;
      throw err;
    }).finally(() => pending.delete(ctx.settings));
    pending.set(ctx.settings, p);
  }
  return p;
}

const isSet = (v: unknown) => v !== undefined && v !== null && v !== '';

/** The run-required settings (registry `runRequired`) that cfg lacks; [] once the app can run. */
export function missingRunRequired(cfg: Config): string[] {
  const c = cfg as Record<string, unknown>;
  return SETTINGS.filter((d) => (typeof d.runRequired === 'function' ? d.runRequired(cfg) : d.runRequired) && !isSet(c[d.key])).map((d) => d.key);
}

/**
 * Whether background jobs may run: setup complete and every run-required setting present. Synchronous (every tick asks), so it reads the
 * cached completion; a cold or outdated cache answers with the last known state and refreshes in the background (a cold one says no).
 */
export function isOperational(ctx: Pick<Ctx, 'db' | 'settings' | 'cfg'>): boolean {
  const c = cache.get(ctx.settings);
  if (!c || c.rev !== ctx.settings.rev()) void isSetupComplete(ctx).catch(() => undefined);
  return Boolean(c?.complete) && missingRunRequired(ctx.cfg).length === 0;
}

/** where a sign-in during setup goes when its setup session is gone: the wizard's code step with the "session expired" note */
export const SETUP_EXPIRED = '/setup?expired=1';
/**
 * Set once the Authentik automation applied and saved the sign-in (routes/setup.ts: step 5 then says "Sign in with Authentik"); holds no
 * value, only the path taken. completeSetup deletes it.
 */
export const SIGNIN_VIA = 'setup:signin:via';

/** kv prefix of the setup sessions (code.ts): all of them end with setup */
export const SETUP_SESSION_PREFIX = 'setup:sess:';
/** how long a second first-admin sign-in waits for the first one's provisioning (Jellyfin calls) before it gives up */
const CLAIM_LOCK_TIMEOUT = '60s';

/**
 * The serial section of the first admin (spec Part F step 5): completes setup with a conditional update and runs `provision` while that
 * transaction holds the settings_meta row, then commits. `provision` writes the admin account on the given connection (`tx`), so the
 * account and the completion commit or roll back together: no admin without a completed setup, even after a failed commit or a crash. Exactly one caller wins, on every instance: a concurrent claim waits on the
 * row lock and then finds setup complete (its update matches no row), so it gets null and follows the normal login rules. A failing
 * `provision` (or a crash) rolls the completion back: setup stays open and the code valid. The rev moves in the same statement, so the
 * other instances drop their cached gate answer (ruling D10). Returns provision's result, or null when setup was already complete.
 */
export async function claimSetup<T>(ctx: Pick<Ctx, 'db'>, provision: (tx: pg.PoolClient) => Promise<T>): Promise<T | null> {
  const c = await (ctx.db as pg.Pool).connect();
  try {
    await c.query('begin');
    // a waiting claim gives up after lock_timeout. The winner holds the row (settings saves wait on it) only while it provisions: a few
    // statements and the media server calls, each of which has its own deadline (jellyfin/client.ts AbortSignal.timeout)
    await c.query(`set local lock_timeout = '${CLAIM_LOCK_TIMEOUT}'`);
    const won = await c.query(`update settings_meta set setup_completed_at = now(), setup_code_hash = null, rev = rev + 1
      where id = 1 and setup_completed_at is null returning rev`);
    if (!won.rowCount) {
      await c.query('rollback');
      return null;
    }
    const result = await provision(c);
    // a transaction that a failed statement aborted (one whose error was caught, such as audit()'s insert) does not throw here: Postgres
    // answers ROLLBACK to the COMMIT. Only a real COMMIT is a win; anything else is a claim that did not happen
    const done = await c.query('commit');
    if (done.command !== 'COMMIT') throw new Error('setup claim rolled back');
    return result;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Completes setup for the first admin `userId` (spec Part E2), after claimSetup committed (which set setup_completed_at, cleared the code
 * and moved the rev): the code cleared once more and setup_completed_at set if it is somehow missing, both only while `userId` is an
 * admin account (completion never happens here on its own: without the claim's admin there is nothing to complete), every setup session deleted, audit `setup.completed`, and the other instances told (their gate opens). It also stamps
 * `reauthAt` on the new admin's session object, which the caller saves afterwards, so the wizard's step 6 can save secrets without another
 * re-authentication. The steps are best effort: setup is complete once the claim committed, so a failing step (a Redis outage) is logged
 * and the admin still gets the session (the setup sessions run out on their TTL, other instances reload on their poll).
 */
export async function completeSetup(ctx: Pick<Ctx, 'db' | 'kv' | 'settings'>, userId: string, session: { reauthAt?: number },
  log: { info(msg: string): void; warn(msg: string): void } = { info: () => {}, warn: () => {} }): Promise<void> {
  const step = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      log.warn(`Setup completion: ${what} failed`); // never the error itself (it might quote a key)
    }
  };
  await step('marking setup complete', () => ctx.db.query(`update settings_meta set setup_code_hash = null,
    setup_completed_at = coalesce(setup_completed_at, now()), rev = rev + case when setup_completed_at is null then 1 else 0 end
    where id = 1 and exists (select 1 from users where id = $1 and role = 'admin')`, [userId]));
  await step('deleting the setup sessions', async () => {
    for (const key of await ctx.kv.keys(SETUP_SESSION_PREFIX)) await ctx.kv.del(key);
    await ctx.kv.del(SIGNIN_VIA); // a stale path if setup is ever reopened by hand
  });
  await audit(ctx, userId, 'setup.completed'); // audit() never throws
  // the second producer of the stamp (next to reauth.ts markReauthenticated), at the session's creation: the person has just signed in
  // at the IdP, and the session is saved by the caller after this
  session.reauthAt = Date.now();
  // reloads here (the gate's cache sees the new rev now) and publishes the rev for the other instances (their poll covers a lost message)
  await step('announcing the change', () => ctx.settings.announce());
  log.info('Setup completed; the setup code is no longer valid.');
}
