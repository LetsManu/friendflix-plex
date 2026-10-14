// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type pg from 'pg';
import { MemoryKV } from '../../src/kv.js';
import type { IdentityPolicy, MediaUser } from '../../src/media/types.js';
import { encodePlexId } from '../../src/plex/ids.js';
import type { PlexMediaServer } from '../../src/plex/service.js';
import { DEFAULT_ROLES, type RoleTemplate } from '../../src/roles.js';
import { resetDb } from '../helpers.js';
import { PlexFake, plexServer } from '../plexfake.js';

export const item = (rk: string | number) => encodePlexId('item', String(rk));
export const tag = (id: string | number) => encodePlexId('tag', String(id));
export const section = (id: string | number) => encodePlexId('section', String(id));

export interface PlexEnv { pool: pg.Pool; ms: PlexMediaServer; fake: PlexFake; kv: MemoryKV; close: () => Promise<void> }

/** Fresh DB + fake + server; `prepare` may mutate the fake before the first sync. */
export async function plexEnv(prepare?: (f: PlexFake) => void): Promise<PlexEnv> {
  const pool = await resetDb();
  const kv = new MemoryKV();
  const fake = new PlexFake();
  prepare?.(fake);
  const { ms } = plexServer(pool, kv, fake);
  await ms.sync.run();
  return { pool, ms, fake, kv, close: async () => { await ms.stop(); await pool.end(); } };
}

let n = 0;
/** A synthetic identity with a role template (+ optional kids caps), as a MediaUser. */
export async function identity(ms: PlexMediaServer, t: RoleTemplate | keyof typeof DEFAULT_ROLES = 'admin', extra: Partial<IdentityPolicy> = {}): Promise<MediaUser> {
  const template = typeof t === 'string' ? DEFAULT_ROLES[t]! : t;
  const { id } = await ms.admin.createIdentity(`user${++n}`, 'pw');
  await ms.admin.applyPolicy(id, { template, disabled: false, ...extra });
  return { id: `u${n}`, jellyfin_user_id: id, jellyfin_username: `user${n}`, jellyfin_pw_enc: '' };
}

/** The kids policy FriendFlix applies (profiles.ts kidsPolicy) for a cap. */
export const kids = (maxRating: number): Partial<IdentityPolicy> => ({ parental: { maxRating, blockUnrated: ['Movie', 'Series', 'Trailer'] }, hidden: true });

export const ids = (list: Array<{ id: string }>) => list.map((i) => i.id).sort();
