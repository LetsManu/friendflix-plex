// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Ctx } from './ctx.js';
import { listLive } from './live.js';
import { parties } from './routes/party.js';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'friendflix_' });

export const httpRequests = new Counter({ name: 'friendflix_http_requests_total', help: 'HTTP requests', labelNames: ['method', 'status'], registers: [registry] });
const activeStreams = new Gauge({ name: 'friendflix_active_streams', help: 'Active playback sessions', registers: [registry] });
const usersTotal = new Gauge({ name: 'friendflix_users_total', help: 'Portal users (not disabled)', registers: [registry] });
const pendingDevices = new Gauge({ name: 'friendflix_pending_devices', help: 'Devices waiting for approval', registers: [registry] });
const partyRooms = new Gauge({ name: 'friendflix_party_rooms', help: 'Open watch-party rooms', registers: [registry] });
const pendingRequests = new Gauge({ name: 'friendflix_pending_polls', help: 'Polls waiting for admin approval', registers: [registry] });
export const authzNginx = new Counter({ name: 'friendflix_authz_nginx_total', help: 'Plan B auth_request decisions', labelNames: ['result'], registers: [registry] });
export const clientErrorsTotal = new Counter({ name: 'friendflix_client_errors_total', help: 'Browser errors reported via POST /api/client-errors', labelNames: ['kind'], registers: [registry] });
// 1.1 post-play screen: aggregates only, bounded labels (state / row kind are fixed enums, never a title or a user)
export const postplayShown = new Counter({ name: 'friendflix_postplay_shown_total', help: 'Post-play screens shown', labelNames: ['state'], registers: [registry] });
export const postplayClick = new Counter({ name: 'friendflix_postplay_click_total', help: 'Post-play suggestions opened', labelNames: ['row_kind'], registers: [registry] });
export const postplayPlay = new Counter({ name: 'friendflix_postplay_play_total', help: 'Post-play suggestions played', labelNames: ['row_kind'], registers: [registry] });
export const postplayDismiss = new Counter({ name: 'friendflix_postplay_dismiss_total', help: 'Post-play screens dismissed', registers: [registry] });
/**
 * Recommendation telemetry (spec 4.7). Labels are bounded by RECO_ROWS / RECO_ENGINES (routes/reco.ts) and never carry an item, a title or a user.
 * Impressions, clicks, plays and dismisses all come from the browser (POST /api/reco/events): a play counts when playback starts on a title opened from a recommendation row.
 */
export const recoImpressions = new Counter({ name: 'friendflix_reco_impressions_total', help: 'Recommendation rows shown, by row and engine', labelNames: ['row', 'engine'], registers: [registry] });
export const recoClicks = new Counter({ name: 'friendflix_reco_clicks_total', help: 'Recommended titles opened, by row and engine', labelNames: ['row', 'engine'], registers: [registry] });
export const recoPlays = new Counter({ name: 'friendflix_reco_plays_total', help: 'Plays started from a recommendation, by row and engine', labelNames: ['row', 'engine'], registers: [registry] });
export const recoDismiss = new Counter({ name: 'friendflix_reco_dismiss_total', help: 'Recommendations dismissed, by row and engine', labelNames: ['row', 'engine'], registers: [registry] });
/**
 * R4 (RECO_ENGINE=v2): v2 threw on a request and v1 answered instead. surface is one of FALLBACK_SURFACES (reco/engine.ts), never a title,
 * a message or a user.
 */
export const recoFallback = new Counter({ name: 'friendflix_reco_fallback_total', help: 'Requests where recommendation engine v2 failed and v1 answered, by surface', labelNames: ['surface'], registers: [registry] });
/**
 * R2 shadow mode (RECO_ENGINE=shadow): v2 computed beside v1 on the "because" path. Labels are bounded (surface is one of five names,
 * result ok|error); nothing about a title, a profile or a user is ever a label or a value.
 */
export const recoShadowRuns = new Counter({ name: 'friendflix_reco_shadow_runs_total', help: 'Shadow comparisons of recommendation engine v2 with v1', labelNames: ['surface', 'result'], registers: [registry] });
export const recoShadowOverlap = new Histogram({ name: 'friendflix_reco_shadow_overlap', help: 'Share of the v1 top 10 that v2 also has in its top 10', labelNames: ['surface'], buckets: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1], registers: [registry] });
export const recoShadowScoreDelta = new Histogram({ name: 'friendflix_reco_shadow_score_delta', help: 'Mean v2 score of the v2 top 10 minus the mean v2 score of the v1 top 10', labelNames: ['surface'], buckets: [-0.25, 0, 0.05, 0.1, 0.2, 0.3, 0.5, 1], registers: [registry] });
/**
 * R3b exploration (RECO_EXPLORE > 0): per row kind and arm (exploit | explore), how many eligible slots were served and the sum of their
 * logged propensities (mean propensity = sum / slots). Labels come from the closed sets ROW_KINDS and {exploit, explore}; no title, item or user.
 */
export const recoExploreSlots = new Counter({ name: 'friendflix_reco_explore_slots_total', help: 'Row slots served by exploration, by row kind and arm', labelNames: ['row', 'arm'], registers: [registry] });
export const recoExplorePropensity = new Counter({ name: 'friendflix_reco_explore_propensity_total', help: 'Sum of the logged propensities of the explored slots, by row kind and arm (divide by the slot counter for the mean)', labelNames: ['row', 'arm'], registers: [registry] });
const downloadJobs = new Gauge({ name: 'friendflix_download_jobs', help: 'Offline download jobs by status', labelNames: ['status'], registers: [registry] });
const downloadDisk = new Gauge({ name: 'friendflix_download_disk_bytes', help: 'Bytes of prepared download files', registers: [registry] });
const recoIndexItems = new Gauge({ name: 'friendflix_reco_index_items', help: 'Films and series in the recommendation item index', registers: [registry] });
const recoIndexAge = new Gauge({ name: 'friendflix_reco_index_age_seconds', help: 'Seconds since the recommendation item index was last refreshed (0 while empty)', registers: [registry] });
/** mode: full | incremental; result: ok | error */
export const recoIndexRuns = new Counter({ name: 'friendflix_reco_index_runs_total', help: 'Recommendation item index passes', labelNames: ['mode', 'result'], registers: [registry] });
const up = new Gauge({ name: 'friendflix_dependency_up', help: '1 if dependency reachable', labelNames: ['dependency'], registers: [registry] });

/** Prometheus endpoint for Icinga. Also blocked in NPM; protected by a bearer token when METRICS_TOKEN is set. */
export async function metricsPlugin(app: FastifyInstance, opts: { ctx: Ctx }) {
  app.addHook('onResponse', async (req, reply) => {
    httpRequests.inc({ method: req.method, status: String(Math.floor(reply.statusCode / 100)) + 'xx' });
  });
  app.get('/metrics', { config: { rateLimit: false } }, async (req, reply) => {
    const t = opts.ctx.cfg.METRICS_TOKEN;
    if (t && req.headers.authorization !== `Bearer ${t}`) return reply.code(401).send('unauthorized');
    const c = opts.ctx;
    activeStreams.set((await listLive(c).catch(() => [])).length);
    partyRooms.set(parties.rooms.size);
    const one = async (sql: string) => Number((await c.db.query<{ n: string }>(sql)).rows[0]?.n ?? 0);
    usersTotal.set(await one('select count(*) n from users where not disabled').catch(() => 0));
    pendingDevices.set(await one('select count(*) n from devices where not approved').catch(() => 0));
    pendingRequests.set(await one("select count(*) n from polls where status='needs_approval'").catch(() => 0));
    const byStatus = await c.db.query<{ status: string; n: string }>('select status, count(*) n from download_jobs group by status').then((r) => r.rows, () => []);
    for (const s of ['queued', 'preparing', 'ready', 'failed']) downloadJobs.set({ status: s }, Number(byStatus.find((r) => r.status === s)?.n ?? 0));
    downloadDisk.set(await one("select coalesce(sum(bytes), 0) n from download_jobs where status = 'ready' and quality <> 'original'").catch(() => 0));
    const idx = await c.db.query<{ n: string; age: string | null }>('select count(*) n, extract(epoch from now() - max(updated_at)) age from item_features').then((r) => r.rows[0], () => undefined);
    recoIndexItems.set(Number(idx?.n ?? 0));
    recoIndexAge.set(Math.max(0, Math.round(Number(idx?.age ?? 0))));
    up.set({ dependency: 'postgres' }, (await c.db.query('select 1').then(() => 1, () => 0)));
    up.set({ dependency: 'redis' }, (await c.kv.ping().catch(() => false)) ? 1 : 0);
    up.set({ dependency: 'jellyfin' }, (await c.jf.admin.ping().catch(() => false)) ? 1 : 0);
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });
}
