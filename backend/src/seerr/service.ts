// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Ctx } from '../ctx.js';
import type { UserRow } from '../types.js';
import { SeerrError } from './client.js';

const norm = (s?: string) => (s ?? '').replace(/-/g, '').toLowerCase();

/** Seerr permission bit REQUEST (Overseerr/Jellyseerr `Permission.REQUEST`): may request movies and series, nothing else. */
export const SEERR_PERMISSION_REQUEST = 32;
/** Email used for a local Seerr user when the account has none (e.g. an OIDC provider that sends no email claim). */
export const placeholderEmail = (userId: string) => `${userId}@friendflix.invalid`;

/**
 * Maps a portal account -> Seerr user so requests are made in the user's name (one Seerr user per account, profiles share it).
 * The strategy follows the media server (capabilities.requestUsers): Jellyfin imports the account's Jellyfin user, every other
 * server gets a local Seerr user.
 */
export async function ensureSeerrUser(ctx: Ctx, user: UserRow): Promise<number> {
  return (ctx.jf.capabilities.requestUsers ?? 'local') === 'jellyfin-import' ? ensureImportedSeerrUser(ctx, user) : ensureLocalSeerrUser(ctx, user);
}

/** Jellyfin: the Seerr user that carries the account's Jellyfin id (imported on first use). */
async function ensureImportedSeerrUser(ctx: Ctx, user: UserRow): Promise<number> {
  if (user.seerr_user_id) return user.seerr_user_id;
  const find = async () => (await ctx.seerr.listUsers()).results.find((u) => norm(u.jellyfinUserId) === norm(user.jellyfin_user_id));
  let su = await find();
  if (!su) {
    await ctx.seerr.importJellyfinUsers([user.jellyfin_user_id]);
    su = await find();
  }
  if (!su) throw new Error('seerr user mapping failed');
  await ctx.db.query('update users set seerr_user_id=$1 where id=$2', [su.id, user.id]);
  user.seerr_user_id = su.id;
  return su.id;
}

const is404 = (e: unknown) => e instanceof SeerrError && e.status === 404;

/**
 * Other servers (no per-user media account): a local Seerr user per account. Stored id (users.seerr_user_id, checked to still
 * exist) -> else a Seerr user with the account's email -> else a new local user with only REQUEST. A stored user that was deleted
 * in Seerr is looked up / created again once. Mapping runs under a per-account advisory lock, so parallel wishes create one user.
 */
async function ensureLocalSeerrUser(ctx: Ctx, user: UserRow): Promise<number> {
  let stale: number | null = null;
  if (user.seerr_user_id) {
    try {
      await ctx.seerr.getUser(user.seerr_user_id);
      return user.seerr_user_id;
    } catch (e) {
      if (!is404(e)) throw e; // Seerr down etc.: the caller's usual error
      stale = user.seerr_user_id; // deleted in Seerr: map again (once)
    }
  }
  const c = await (ctx.db as pg.Pool).connect();
  try {
    await c.query('begin');
    await c.query("select pg_advisory_xact_lock(hashtext('seerruser:' || $1::text))", [user.id]);
    const cur = (await c.query<{ seerr_user_id: number | null }>('select seerr_user_id from users where id=$1', [user.id])).rows[0]?.seerr_user_id ?? null;
    // a parallel request mapped the account while we waited for the lock: use its result
    const id = cur && cur !== stale ? cur : await findOrCreateLocalUser(ctx, user);
    await c.query('update users set seerr_user_id=$1 where id=$2', [id, user.id]);
    await c.query('commit');
    user.seerr_user_id = id;
    return id;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

async function findByEmail(ctx: Ctx, email: string): Promise<number | null> {
  const take = 100;
  for (let skip = 0, pages = 0; pages < 100; pages++) {
    const r = (await ctx.seerr.listUsersPage(take, skip)).results ?? [];
    const hit = r.find((u) => (u.email ?? '').trim().toLowerCase() === email);
    if (hit) return hit.id;
    if (r.length < take) return null;
    skip += r.length;
  }
  return null;
}

async function findOrCreateLocalUser(ctx: Ctx, user: UserRow): Promise<number> {
  const email = (user.email ?? '').trim().toLowerCase() || placeholderEmail(user.id);
  const found = await findByEmail(ctx, email);
  if (found) return found; // an existing Seerr user keeps its own permissions
  const username = user.name.trim() || email;
  let created: { id: number };
  try {
    created = await ctx.seerr.createLocalUser({ email, username, password: randomBytes(24).toString('base64url') });
  } catch (e) {
    // created meanwhile outside this lock (another instance, or by hand): take that one
    const again = e instanceof SeerrError && e.status === 409 ? await findByEmail(ctx, email) : null;
    if (again) return again;
    throw e;
  }
  if (!created?.id) throw new Error('seerr user mapping failed');
  try {
    // Seerr gives new users its default permissions: set exactly REQUEST (never ADMIN, no auto-approve)
    await ctx.seerr.setUserPermissions(created.id, username, SEERR_PERMISSION_REQUEST);
  } catch (e) {
    await ctx.seerr.deleteUser(created.id).catch(() => undefined); // no half-configured user that a later lookup would adopt
    throw e;
  }
  return created.id;
}
