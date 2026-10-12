import type { Config } from './config.js';
import type { Db } from './db.js';
import type { JellyfinService } from './jellyfin/service.js';
import type { KV } from './kv.js';
import type { OidcProvider } from './oidc.js';
import type { RoleTemplate } from './roles.js';
import type { SeerrClient } from './seerr/client.js';

/** Everything the routes need. Built once in server.ts; tests inject fakes. */
export interface Ctx {
  cfg: Config;
  kv: KV;
  db: Db;
  oidc: OidcProvider;
  jf: JellyfinService;
  seerr: SeerrClient;
  roles: Record<string, RoleTemplate>;
  encKey: Buffer;
  fetchImpl: typeof fetch;
}
