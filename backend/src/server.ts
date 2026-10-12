import { Redis } from 'ioredis';
import pg from 'pg';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { keyFromBase64 } from './crypto.js';
import { migrate } from './db.js';
import { createMediaServer, mediaConfigProblems } from './media/index.js';
import { dispatchMediaEvent } from './media/events.js';
import { RedisKV } from './kv.js';
import { authentikConfigProblem } from './invites.js';
import { createAuthentikProvider } from './oidc.js';
import { SeerrClient } from './seerr/client.js';
import { loadRoles } from './roles.js';
import { nightlyTick } from './healthcheck.js';
import { digestTick } from './digest.js';
import { reapplyPoliciesOnce } from './users.js';
import { pushEnabled } from './push.js';
import { previews } from './previews.js';
import { gcDownloads, startPreparerTick } from './downloadprep.js';
import { gcLicenses } from './downloads.js';
import { pollJellyfinSessions } from './routes/internal.js';
import { parties } from './routes/party.js';
import { calendarNotifications, pollTick } from './routes/polls.js';
import { resolveRequestedPolls } from './polls.js';
import { reminderTick } from './reminders.js';
import { leavingTick, qualityIndexTick } from './fresh.js';
import { langIndexTick } from './langindex.js';
import type { Ctx } from './ctx.js';

const cfg = loadConfig();
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 10 });
await migrate(pool);
const kv = new RedisKV(new Redis(cfg.REDIS_URL));
const encKey = keyFromBase64(cfg.APP_ENC_KEY);
const mediaProblems = mediaConfigProblems(cfg);
if (mediaProblems.length) throw new Error(`MEDIA_SERVER=${cfg.MEDIA_SERVER}: ${mediaProblems.join('; ')}`);

const ctx: Ctx = {
  cfg, kv, db: pool, encKey, fetchImpl: fetch,
  oidc: await createAuthentikProvider(cfg),
  jf: createMediaServer({ cfg, kv, db: pool, encKey }),
  seerr: new SeerrClient(cfg.SEERR_URL, cfg.SEERR_API_KEY),
  roles: loadRoles(cfg.ROLE_TEMPLATES),
};

const app = await buildApp(ctx);
await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
// the media server's own change feed (websocket, sync job …), if it has one; Jellyfin pushes webhooks instead
await ctx.jf.start?.({ dispatch: (e) => dispatchMediaEvent(ctx, e), log: app.log });
// one-off: push the changed role policies (guest transcoding) to every existing Jellyfin user
void reapplyPoliciesOnce(ctx).catch((e) => app.log.warn({ e }, 'role policy re-apply failed'));
pushEnabled(cfg); // validates the VAPID pair once (warns and disables push when invalid)
const akMissing = authentikConfigProblem(cfg);
if (akMissing) app.log.warn({ missing: akMissing }, `Authentik invitations disabled: ${akMissing.join(', ')} not set (see docs/integrations.md)`);
else if (!cfg.AUTHENTIK_URL) app.log.info('Authentik invitations off: invited people need an existing Authentik account');

const timers: NodeJS.Timeout[] = [];
timers.push(setInterval(() => parties.tick(), 1000));
let pollTickBusy = false;
timers.push(setInterval(() => {
  if (pollTickBusy) return;
  pollTickBusy = true;
  void pollTick(ctx).catch((e) => app.log.warn({ e }, 'poll tick failed')).finally(() => { pollTickBusy = false; });
}, 5_000));
timers.push(setInterval(() => void resolveRequestedPolls(ctx).catch((e) => app.log.warn({ e }, 'resolve failed')), 60_000));
timers.push(setInterval(() => void calendarNotifications(ctx).catch((e) => app.log.warn({ e }, 'calendar job failed')), 3600_000));
if (cfg.PREVIEW_WARM === 'true') {
  timers.push(setInterval(() => void previews(ctx).warmTick().catch((e) => app.log.warn({ e }, 'preview warm failed')), 60_000));
}
timers.push(setInterval(() => void reminderTick(ctx).catch((e) => app.log.warn({ e }, 'reminder tick failed')), 1800_000));
timers.push(setInterval(() => void nightlyTick(ctx).catch((e) => app.log.warn({ e }, 'playback check failed')), 600_000));
timers.push(setInterval(() => void digestTick(ctx).catch((e) => app.log.warn({ e }, 'digest tick failed')), 600_000));
if (cfg.BACKGROUND_JOBS === 'true') {
  if (cfg.DOWNLOADS_ENABLED === 'true') {
    timers.push(setInterval(() => void startPreparerTick(ctx).catch((e) => app.log.warn({ e }, 'download prep tick failed')), 15_000));
    timers.push(setInterval(() => void gcDownloads(ctx).then(() => gcLicenses(ctx)).catch((e) => app.log.warn({ e }, 'download gc failed')), 600_000));
    void startPreparerTick(ctx).catch((e) => app.log.warn({ e }, 'download prep start failed'));
  }
  timers.push(setInterval(() => void langIndexTick(ctx), 1800_000)); // self-limits to every 12 h, never throws
  void langIndexTick(ctx);
  timers.push(setInterval(() => void qualityIndexTick(ctx), 1800_000)); // 4K / HDR browse filter; self-limits to every 12 h, never throws
  void qualityIndexTick(ctx);
  timers.push(setInterval(() => void leavingTick(ctx).catch((e) => app.log.warn({ e }, 'leaving-soon tick failed')), 1800_000)); // expired dates + 7-day / last-day notices
  timers.push(setInterval(() => void pollJellyfinSessions(ctx).catch((e) => app.log.warn({ e }, 'session poll failed')), 10_000));
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    timers.forEach(clearInterval);
    void Promise.resolve(ctx.jf.stop?.()).catch(() => undefined).then(() => app.close()).then(() => process.exit(0));
  });
}
