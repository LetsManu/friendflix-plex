import type { Ctx } from '../ctx.js';
import type { UserRow } from '../types.js';

const norm = (s?: string) => (s ?? '').replace(/-/g, '').toLowerCase();

/** Maps portal user -> Seerr user (via Jellyfin id) so requests are made in the user's name. */
export async function ensureSeerrUser(ctx: Ctx, user: UserRow): Promise<number> {
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
