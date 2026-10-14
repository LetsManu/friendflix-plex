// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Ctx } from './ctx.js';
import { encrypt, hashPin, randomPassword } from './crypto.js';
import { MediaError, type IdentityPolicy } from './media/types.js';
import { effectiveRole } from './roles.js';
import { applyRole } from './users.js';
import type { JfUser, ProfileRow, UserRow } from './types.js';
import type { Session } from './session.js';

export const MAX_PROFILES = 5;
/** parental caps a kids profile can have (Jellyfin MaxParentalRating: FSK 0 / 6 / 12 and their equivalents) */
export const KIDS_RATINGS = [0, 6, 12] as const;
export type KidsRating = (typeof KIDS_RATINGS)[number];
/**
 * Unrated titles of these kinds stay hidden from kids (Jellyfin BlockUnratedItems; episodes follow their series).
 * Folders/"Other" are left alone, otherwise the library views themselves would disappear.
 */
export const KIDS_BLOCK_UNRATED = ['Movie', 'Series', 'Trailer'] as const;

/** Business errors of the profile service; `code` is the API error string. */
export class ProfileError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

const jfSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 20);

export async function listProfiles(ctx: Pick<Ctx, 'db'>, userId: string): Promise<ProfileRow[]> {
  const r = await ctx.db.query<ProfileRow>('select * from profiles where user_id=$1 order by is_owner desc, created_at, name', [userId]);
  return r.rows;
}

export async function getProfile(ctx: Pick<Ctx, 'db'>, userId: string, profileId: string): Promise<ProfileRow | null> {
  const r = await ctx.db.query<ProfileRow>('select * from profiles where id=$1 and user_id=$2', [profileId, userId]);
  return r.rows[0] ?? null;
}

export async function ownerProfile(ctx: Pick<Ctx, 'db'>, user: Pick<UserRow, 'id' | 'name'>): Promise<ProfileRow> {
  const sel = async () => (await ctx.db.query<ProfileRow>('select * from profiles where id=$1', [user.id])).rows[0];
  const found = await sel();
  if (found) return found;
  // lazily heals a missing owner row (e.g. an account created between migration and deploy)
  const base = (user.name ?? '').slice(0, 20).trim() || 'Profil';
  const candidates = [base, 'Profil', `${base.slice(0, 16)} (1)`, `${base.slice(0, 16)} (2)`];
  for (const name of candidates) {
    try {
      await ctx.db.query('insert into profiles(id, user_id, name, is_owner) values ($1,$1,$2,true) on conflict (id) do nothing', [user.id, name]);
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e; // (user_id, lower(name)) taken -> next candidate
    }
  }
  const row = await sel();
  if (!row) throw new Error('owner profile could not be created');
  return row;
}

/**
 * Jellyfin policy fields a kids profile adds on top of its role: the lower of role cap and kids cap, unrated titles hidden.
 * A normal profile user gets the unrated block cleared again (it may have been a kids profile before).
 */
export function kidsPolicy(p: Pick<ProfileRow, 'kids' | 'kids_max_rating'>, roleCap: number | null): NonNullable<IdentityPolicy['parental']> {
  if (!p.kids) return { blockUnrated: [] };
  return { maxRating: roleCap === null ? p.kids_max_rating : Math.min(roleCap, p.kids_max_rating), blockUnrated: [...KIDS_BLOCK_UNRATED] };
}

/** kidsPolicy() for a Jellyfin user id: undefined for an account's own Jellyfin user (owner profiles are never kids profiles). */
export async function kidsPolicyFor(ctx: Pick<Ctx, 'db'>, jellyfinUserId: string, roleCap: number | null): Promise<IdentityPolicy['parental']> {
  const r = await ctx.db.query<Pick<ProfileRow, 'kids' | 'kids_max_rating'>>('select kids, kids_max_rating from profiles where jellyfin_user_id=$1', [jellyfinUserId]);
  return r.rows[0] ? kidsPolicy(r.rows[0], roleCap) : undefined;
}

/** The kids profile a device last ran (switching away from it needs a PIN, a new login on the device lands on it again). */
export async function deviceKidsProfile(ctx: Pick<Ctx, 'db'>, userId: string, deviceId: string | undefined): Promise<ProfileRow | null> {
  if (!deviceId) return null;
  const r = await ctx.db.query<ProfileRow>(
    'select p.* from devices d join profiles p on p.id=d.kids_profile_id where d.user_id=$1 and d.device_id=$2 and p.kids', [userId, deviceId]);
  return r.rows[0] ?? null;
}

/** Remembers (kids profile) or clears (any other profile) the kids lock of a device. */
export async function setDeviceKids(ctx: Pick<Ctx, 'db'>, userId: string, deviceId: string | undefined, kidsProfileId: string | null): Promise<void> {
  if (!deviceId) return;
  await ctx.db.query('update devices set kids_profile_id=$3 where user_id=$1 and device_id=$2', [userId, deviceId, kidsProfileId]);
}

/** The Jellyfin identity of a profile: the owner profile acts as the account itself, others as their hidden Jellyfin user. */
export function jfUserFor(user: JfUser, profile: ProfileRow): JfUser {
  if (profile.is_owner || !profile.jellyfin_user_id) return user;
  return { id: profile.id, jellyfin_user_id: profile.jellyfin_user_id, jellyfin_username: profile.jellyfin_username!, jellyfin_pw_enc: profile.jellyfin_pw_enc! };
}

/**
 * Active profile of a session: the chosen one if it still exists and belongs to the account, else the kids profile the device is
 * locked to (a new login on a kid's device), else the owner profile (old sessions, deleted profile) unless it is PIN protected
 * -> null (the client must pick a profile).
 */
export async function resolveProfile(ctx: Pick<Ctx, 'db'>, user: UserRow, session: Pick<Session, 'profileId' | 'deviceId'>): Promise<ProfileRow | null> {
  if (session.profileId) {
    const p = await getProfile(ctx, user.id, session.profileId);
    if (p) return p;
  }
  const kid = await deviceKidsProfile(ctx, user.id, session.deviceId);
  if (kid) return kid;
  const owner = await ownerProfile(ctx, user);
  return owner.pin_hash ? null : owner;
}

/** All Jellyfin user ids of an account: its own plus those of its non-owner profiles. */
export async function accountJellyfinIds(ctx: Pick<Ctx, 'db'>, userId: string): Promise<string[]> {
  const r = await ctx.db.query<{ id: string }>(
    `select jellyfin_user_id id from users where id=$1
     union select jellyfin_user_id from profiles where user_id=$1 and jellyfin_user_id is not null`,
    [userId],
  );
  return r.rows.map((x) => x.id);
}

export async function createProfile(ctx: Ctx, user: UserRow, b: { name: string; avatar?: string; pin?: string | null; kids?: boolean; maxRating?: KidsRating }): Promise<ProfileRow> {
  const name = b.name.trim();
  const count = async () => Number((await ctx.db.query<{ n: string }>('select count(*) n from profiles where user_id=$1', [user.id])).rows[0]!.n);
  if ((await count()) >= MAX_PROFILES) throw new ProfileError(409, 'max_profiles');
  const taken = await ctx.db.query('select 1 from profiles where user_id=$1 and lower(name)=lower($2)', [user.id, name]);
  if (taken.rowCount) throw new ProfileError(409, 'name_taken');

  const password = randomPassword();
  const base = `${jfSafe(user.jellyfin_username)}-${jfSafe(name) || 'profil'}`.slice(0, 40);
  let jf: { id: string } | undefined;
  let jfName = base;
  for (let attempt = 0; attempt < 4 && !jf; attempt++) {
    jfName = attempt === 0 ? base : `${base}${Math.floor(100 + Math.random() * 900)}`;
    try {
      jf = await ctx.jf.admin.createIdentity(jfName, password);
    } catch {
      if (attempt === 3) throw new ProfileError(502, 'jellyfin');
    }
  }
  try {
    const kids = { kids: Boolean(b.kids), kids_max_rating: b.maxRating ?? 12 };
    // the row does not exist yet: the kids fields go in as extra policy (applyRole adds them itself on every later re-apply)
    await applyRole(ctx, jf!.id, user.role, user.disabled, { hidden: true, ...(kids.kids ? { parental: kidsPolicy(kids, (await effectiveRole(ctx, user.role))?.maxParentalRating ?? null) } : {}) });
    const id = randomUUID();
    const pool = ctx.db as pg.Pool;
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query("select pg_advisory_xact_lock(hashtext('prof:' || $1::text))", [user.id]);
      const n = Number((await c.query<{ n: string }>('select count(*) n from profiles where user_id=$1', [user.id])).rows[0]!.n);
      if (n >= MAX_PROFILES) {
        await c.query('rollback');
        throw new ProfileError(409, 'max_profiles');
      }
      const ins = await c.query<ProfileRow>(
        `insert into profiles(id, user_id, name, avatar, pin_hash, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, kids, kids_max_rating)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [id, user.id, name, b.avatar ?? 'red', b.pin ? hashPin(b.pin) : null, jf!.id, jfName, encrypt(ctx.encKey, password), kids.kids, kids.kids_max_rating],
      );
      await c.query('commit');
      return ins.rows[0]!;
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  } catch (e) {
    await ctx.jf.admin.deleteIdentity(jf!.id).catch(() => undefined); // roll back the orphaned Jellyfin user
    if (e instanceof ProfileError) throw e;
    if (e instanceof MediaError) throw new ProfileError(502, 'jellyfin');
    if ((e as { code?: string }).code === '23505') throw new ProfileError(409, 'name_taken');
    throw e;
  }
}

/** Deletes a non-owner profile: Jellyfin user first (502 if that fails), then the row (per-profile data cascades). */
export async function deleteProfile(ctx: Ctx, p: ProfileRow): Promise<void> {
  if (p.is_owner) throw new ProfileError(400, 'owner_not_deletable');
  if (p.jellyfin_user_id) {
    const ok = await ctx.jf.admin.deleteIdentity(p.jellyfin_user_id).then(() => true, () => false);
    if (!ok) throw new ProfileError(502, 'jellyfin');
  }
  await ctx.db.query('delete from profiles where id=$1', [p.id]);
  await ctx.kv.del(`jft:${p.id}`);
}

export const publicProfile = (p: ProfileRow) => ({
  id: p.id, name: p.name, avatar: p.avatar, isOwner: p.is_owner,
  kids: Boolean(p.kids), ...(p.kids ? { maxRating: p.kids_max_rating } : {}),
});
