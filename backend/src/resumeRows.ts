import type { Ctx } from './ctx.js';
import type { ItemDto } from './media/types.js';
import { tidyResume } from './resume.js';
import type { JfUser } from './types.js';

/** Shared by GET /api/library/resume|nextup and GET /api/home, so both show exactly the same rows. */

/** Items of this profile's "dropped" list (movie or series ids) are hidden from Weiterschauen / Als Nächstes. */
export async function droppedSet(ctx: Ctx, profileId: string): Promise<Set<string>> {
  return new Set((await ctx.db.query<{ item_id: string }>('select item_id from dropped where profile_id=$1', [profileId])).rows.map((r) => r.item_id));
}
export const notDropped = (items: ItemDto[], dropped: Set<string>) => (dropped.size ? items.filter((i) => !dropped.has(i.seriesId ?? i.id) && !dropped.has(i.id)) : items);

/** Data of GET /api/library/resume. */
export async function resumeItems(ctx: Ctx, jfUser: JfUser, profileId: string): Promise<ItemDto[]> {
  const items = await ctx.jf.resume(jfUser);
  const h = await ctx.db.query<{ item_id: string; hidden_at: Date }>('select item_id, hidden_at from resume_hidden where profile_id=$1', [profileId]);
  return notDropped(tidyResume(items, new Map(h.rows.map((r) => [r.item_id, r.hidden_at]))), await droppedSet(ctx, profileId));
}

/** Data of GET /api/library/nextup (`seriesId` asks for that series' next episode directly). */
export async function nextUpItems(ctx: Ctx, jfUser: JfUser, profileId: string, seriesId?: string): Promise<ItemDto[]> {
  return notDropped(await ctx.jf.nextUp(jfUser, seriesId), await droppedSet(ctx, profileId));
}
