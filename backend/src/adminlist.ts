/** Query helpers of the admin list endpoints (users, devices, invites, audit): search, filter, sort and paging, all parameterised. */
import { z } from 'zod';

/** `?q=&sort=&dir=&limit=&offset=` – all optional, so old callers (no params) keep getting the plain list */
export const pageQuery = z.object({
  q: z.string().trim().max(100).optional(),
  sort: z.string().max(30).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});
export type PageQuery = z.infer<typeof pageQuery>;

/** `%text%` for ILIKE with the wildcard characters of the input escaped */
export const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Collects WHERE conditions with numbered parameters ($1, $2 …). */
export class Where {
  readonly params: unknown[] = [];
  private readonly parts: string[] = [];
  /** adds a condition; `sql` uses `?` where the value goes (one value per condition) */
  add(sql: string, value?: unknown): void {
    if (value === undefined) this.parts.push(sql);
    else { this.params.push(value); this.parts.push(sql.replace('?', `$${this.params.length}`)); }
  }
  /** adds a parameter and returns its placeholder (for conditions that use one value several times) */
  param(value: unknown): string { this.params.push(value); return `$${this.params.length}`; }
  get sql(): string { return this.parts.length ? `where ${this.parts.join(' and ')}` : ''; }
}

/** `order by` from a whitelist of sort keys (never from raw input); `fallback` is the default order */
export function orderBy(columns: Record<string, string>, sort: string | undefined, dir: 'asc' | 'desc' | undefined, fallback: string): string {
  const col = sort && Object.hasOwn(columns, sort) ? columns[sort] : undefined;
  if (!col) return `order by ${fallback}`;
  return `order by ${col} ${dir === 'desc' ? 'desc' : 'asc'} nulls last, ${fallback}`;
}
