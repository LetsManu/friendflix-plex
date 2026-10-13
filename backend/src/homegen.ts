import type { Ctx } from './ctx.js';

/**
 * Generation counters in the key of the GET /api/home cache: a write that changes what the home page shows bumps one and the next
 * request builds a fresh answer instead of serving the cached one for up to 60 s. `homegen:<profileId>` for a profile's own state
 * (hidden resume entries, watch status, thumbs, ratings), `homegen:all` for admin edits everyone sees (brand hubs, removal dates,
 * themed lists). Redis failures are ignored: the 60 s TTL is the fallback.
 */
const TTL = 7 * 86400;

export async function bumpHome(ctx: Pick<Ctx, 'kv'>, profileId: string): Promise<void> {
  await ctx.kv.incr(`homegen:${profileId}`, TTL).catch(() => undefined);
}
export async function bumpHomeAll(ctx: Pick<Ctx, 'kv'>): Promise<void> {
  await ctx.kv.incr('homegen:all', TTL).catch(() => undefined);
}
/** `<profile counter>:<global counter>` in one round trip */
export async function homeGens(ctx: Pick<Ctx, 'kv'>, profileId: string): Promise<string> {
  const [p, a] = await ctx.kv.mget([`homegen:${profileId}`, 'homegen:all']).catch(() => [null, null]);
  return `${p ?? 0}:${a ?? 0}`;
}
