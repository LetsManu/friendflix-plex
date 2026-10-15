// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
import { effectiveLimits } from './limits.js';

/** Default monthly Seerr wishes per role; null = unlimited. Unknown roles (ROLE_TEMPLATES extras) get DEFAULT_LIMIT. */
const DEFAULT_LIMIT = 2;
export const defaultLimit = (role: string): number | null => (role === 'admin' ? null : DEFAULT_LIMIT);

/** The role's monthly limit (role_settings, else the default); the per-user override is applied by limitFor. */
export async function roleLimitFor(ctx: Pick<Ctx, 'db'>, role: string): Promise<number | null> {
  const r = await ctx.db.query<{ requests_per_month: number | null }>('select requests_per_month from role_settings where role=$1', [role]);
  return r.rowCount ? r.rows[0]!.requests_per_month : defaultLimit(role);
}
/** The user's monthly limit: their override, else the role's (null = unlimited). */
export async function limitFor(ctx: Pick<Ctx, 'db' | 'roles'>, user: { id: string; role: string }): Promise<number | null> {
  const l = await effectiveLimits(ctx, user);
  return l ? l.requestsPerMonth : roleLimitFor(ctx, user.role);
}

/** First day of next month (server-local, same clock as the usage count). */
export async function resetsAt(ctx: Pick<Ctx, 'db'>): Promise<string> {
  const r = await ctx.db.query<{ t: Date }>("select date_trunc('month', now()) + interval '1 month' t");
  return r.rows[0]!.t.toISOString();
}

/** This month's user-sourced wishes (poll requests are admin-approved and excluded). */
export async function usage(ctx: Pick<Ctx, 'db'>, userId: string): Promise<number> {
  const r = await ctx.db.query<{ n: string }>("select count(*) n from seerr_requests where user_id=$1 and source='user' and created_at >= date_trunc('month', now())", [userId]);
  return Number(r.rows[0]!.n);
}

export async function quota(ctx: Pick<Ctx, 'db' | 'roles'>, user: { id: string; role: string }) {
  const limit = await limitFor(ctx, user);
  const used = await usage(ctx, user.id);
  return { limit, used, remaining: limit === null ? null : Math.max(0, limit - used), resetsAt: await resetsAt(ctx) };
}

/** Atomically takes a slot (null = limit reached). Release it once the wish is stored or Seerr failed. */
export async function reserve(ctx: Pick<Ctx, 'db'>, userId: string, limit: number | null): Promise<number | null> {
  const r = await ctx.db.query<{ id: string | null }>('select reserve_request_slot($1,$2) id', [userId, limit]);
  const id = r.rows[0]!.id;
  return id === null ? null : Number(id);
}
export const release = (ctx: Pick<Ctx, 'db'>, id: number) => ctx.db.query('delete from request_reservations where id=$1', [id]).then(() => undefined, () => undefined);
