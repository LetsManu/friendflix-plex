// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';

export type ListRole = 'owner' | 'editor' | 'viewer';
/** Read-only visitor of a featured list (not a member). */
export type ListAccess = ListRole | 'guest';

export const MAX_FEATURED = 5;
export const MAX_FEATURED_ITEMS = 24;

export const MAX_OWNED = 20;
export const MAX_ITEMS = 500;
export const MAX_MEMBERS = 20;

/** The user's role on a list, or null when the list does not exist or the user is not a member (callers answer 404). */
export async function listRole(ctx: Pick<Ctx, 'db'>, listId: string, userId: string): Promise<ListRole | null> {
  const r = await ctx.db.query<{ role: ListRole }>(
    `select 'owner' as role from lists where id = $1 and owner_id = $2
     union all select role from list_members where list_id = $1 and user_id = $2`,
    [listId, userId],
  );
  return r.rows[0]?.role ?? null;
}

export const canEdit = (role: ListRole | null) => role === 'owner' || role === 'editor';

export async function isFeatured(ctx: Pick<Ctx, 'db'>, listId: string): Promise<boolean> {
  return Boolean((await ctx.db.query('select 1 from lists where id = $1 and featured_at is not null', [listId])).rowCount);
}
