import type { Config } from './config.js';
import type { Db } from './db.js';
import type { KV } from './kv.js';
import type { MediaServer } from './media/types.js';
import type { OidcProvider } from './oidc.js';
import type { RoleTemplate } from './roles.js';
import type { SeerrClient } from './seerr/client.js';

/** Everything the routes need. Built once in server.ts; tests inject fakes. */
export interface Ctx {
  cfg: Config;
  kv: KV;
  db: Db;
  oidc: OidcProvider;
  /** the media server (name kept from the Jellyfin-only days): see media/types.ts */
  jf: MediaServer;
  seerr: SeerrClient;
  roles: Record<string, RoleTemplate>;
  encKey: Buffer;
  fetchImpl: typeof fetch;
}
