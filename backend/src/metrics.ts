// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
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
const downloadJobs = new Gauge({ name: 'friendflix_download_jobs', help: 'Offline download jobs by status', labelNames: ['status'], registers: [registry] });
const downloadDisk = new Gauge({ name: 'friendflix_download_disk_bytes', help: 'Bytes of prepared download files', registers: [registry] });
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
    up.set({ dependency: 'postgres' }, (await c.db.query('select 1').then(() => 1, () => 0)));
    up.set({ dependency: 'redis' }, (await c.kv.ping().catch(() => false)) ? 1 : 0);
    up.set({ dependency: 'jellyfin' }, (await c.jf.admin.ping().catch(() => false)) ? 1 : 0);
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });
}
