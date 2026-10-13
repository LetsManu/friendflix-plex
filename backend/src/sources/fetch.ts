import type { Ctx } from '../ctx.js';
import { CACHE_PREFIX, getSourceKey, INVALID_KEY, OMDB_COUNT_KEY, OMDB_DAILY_BUDGET, PAUSE_KEY, type SourceName } from './keys.js';

export const EXT_TIMEOUT_MS = 3000;
export const EXT_OK_TTL = 604_800;
export const EXT_FAIL_TTL = 3600;
export interface ExtRequest { url: string; headers?: Record<string, string> }
export type ExtLog = { warn(o: object): void };

/** Thrown internally only; carries nothing but a status so no URL or key can leak through it. */
class ExtError extends Error {
  constructor(readonly status: number | 'timeout' | 'error') { super('ext'); }
}

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

/** One HTTP GET with a hard 3 s limit; resolves the parsed JSON or throws ExtError (never with URL or key). */
export async function extRequest(ctx: Ctx, req: ExtRequest): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = ctx.fetchImpl(req.url, { headers: req.headers, signal: AbortSignal.timeout(EXT_TIMEOUT_MS) }).then(async (res) => {
      if (!res.ok) throw new ExtError(res.status);
      return res.json() as Promise<unknown>;
    });
    call.catch(() => undefined); // a late rejection after the timeout race must not be unhandled
    const limit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new ExtError('timeout')), EXT_TIMEOUT_MS); });
    return await Promise.race([call, limit]);
  } catch (e) {
    if (e instanceof ExtError) throw e;
    const name = (e as { name?: string } | null)?.name;
    throw new ExtError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const statusOf = (e: unknown): number | 'timeout' | 'error' => (e instanceof ExtError ? e.status : 'error');

/** Reserves one OMDb call of today's budget; false when it is used up. */
export async function omdbReserve(ctx: Ctx): Promise<boolean> {
  return (await ctx.kv.incr(OMDB_COUNT_KEY(utcDay()), 2 * 86_400)) <= OMDB_DAILY_BUDGET;
}

export async function extFetch<T>(
  ctx: Ctx, name: SourceName, cacheKey: string, url: (key: string) => ExtRequest, parse: (j: unknown) => T, log?: ExtLog,
): Promise<T | null> {
  const k = await getSourceKey(ctx, name);
  if (!k) return null;
  if ((await ctx.kv.get(PAUSE_KEY(name))) !== null) return null;
  const ck = CACHE_PREFIX(name) + cacheKey;
  const hit = await ctx.kv.get(ck);
  if (hit !== null) {
    try {
      const o = JSON.parse(hit) as { v?: T; f?: number };
      return o.f ? null : (o.v ?? null);
    } catch { /* corrupt entry: refetch */ }
  }
  if (name === 'omdb' && !(await omdbReserve(ctx))) return null;
  try {
    const out = parse(await extRequest(ctx, url(k.key)));
    await ctx.kv.set(ck, JSON.stringify({ v: out }), EXT_OK_TTL);
    return out;
  } catch (e) {
    const status = statusOf(e);
    log?.warn({ source: name, status });
    if (status === 401) {
      await ctx.kv.set(PAUSE_KEY(name), '1', 3600);
      await ctx.kv.set(INVALID_KEY(name), '1', 3600);
    } else {
      await ctx.kv.set(ck, '{"f":1}', EXT_FAIL_TTL);
    }
    return null;
  }
}
