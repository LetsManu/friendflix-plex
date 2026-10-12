import type { Ctx } from './ctx.js';

export async function audit(ctx: Pick<Ctx, 'db'>, actor: string | null, action: string, target?: string, meta: Record<string, unknown> = {}) {
  await ctx.db.query('insert into audit_log(actor, action, target, meta) values ($1,$2,$3,$4)', [actor, action, target ?? null, JSON.stringify(meta)]).catch(() => undefined);
}
