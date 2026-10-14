// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { MediaError } from '../media/types.js';
import { SeerrError } from '../seerr/client.js';

/** Jellyfin item id: 32 hex chars; dashed UUIDs are accepted and normalised. */
export const id32 = z.string().transform((s) => s.replace(/-/g, '').toLowerCase()).pipe(z.string().regex(/^[0-9a-f]{32}$/));

export interface WrapOptions {
  /** ZodError handling: 'issues' → 400 {error,issues:[paths]}, 'plain' → 400 {error}, omitted → rethrown. */
  zod?: 'issues' | 'plain';
  /** media server (MediaError) statuses mapped to 404 {error:'not_found', status}. */
  notFound?: number[];
  /** media server statuses passed through as-is with {error:'jellyfin', status} (error name kept for API compatibility). */
  passthrough?: number[];
  /** MediaErrors handled at all (default true). */
  jellyfin?: boolean;
  /** SeerrError → 502 {error:'seerr', status} (default false). */
  seerr?: boolean;
  /** Include `status` in the seerr body (default true). */
  seerrStatus?: boolean;
}

/** Wraps a route handler and maps upstream/validation errors to HTTP responses. Anything else is rethrown. */
export function wrap<T extends (...a: any[]) => Promise<any>>(fn: T, o: WrapOptions = {}): T {
  const jellyfin = o.jellyfin ?? true;
  return (async (req: any, reply: any) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (o.zod && e instanceof z.ZodError) {
        return reply.code(400).send(o.zod === 'issues' ? { error: 'bad_request', issues: e.issues.map((i) => i.path.join('.')) } : { error: 'bad_request' });
      }
      if (jellyfin && e instanceof MediaError) { // JellyfinError and any other implementation's error extend MediaError
        if (o.notFound?.includes(e.status)) return reply.code(404).send({ error: 'not_found', status: e.status });
        return reply.code(o.passthrough?.includes(e.status) ? e.status : 502).send({ error: 'jellyfin', status: e.status });
      }
      if (o.seerr && e instanceof SeerrError) return reply.code(502).send({ error: 'seerr', status: e.status });
      throw e;
    }
  }) as T;
}
