// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { Docker, execRunner, type ImageInfo, type ServiceState } from './docker.js';
import { Updater, type Ops } from './job.js';
import { FF_SERVICES, HEALTH_SERVICES, SELF_SERVICE, channelTag, parseChannelBody, shaTag } from './policy.js';
import { ReplayCache, deriveKey, verify, type Verifier } from './protocol.js';
import { fileStore } from './state.js';

const MAX_BODY = 1024;
type Route = 'status' | 'channel' | 'update' | 'rollback' | 'self-update';
/** the whole API: five fixed actions */
const ROUTES: Record<string, { method: 'GET' | 'POST'; route: Route }> = {
  '/v1/status': { method: 'GET', route: 'status' },
  '/v1/channel': { method: 'POST', route: 'channel' },
  '/v1/update': { method: 'POST', route: 'update' },
  '/v1/rollback': { method: 'POST', route: 'rollback' },
  '/v1/self-update': { method: 'POST', route: 'self-update' },
};

export interface ServiceView { service: string; state: string; health: string; sha: string | null; version: string | null }
export interface AppDeps {
  updater: Updater;
  verifier: Verifier;
  /** what runs now, per service (cached by the caller) */
  services: () => Promise<ServiceView[]>;
  self: { version: string | null; sha: string | null };
  /** auth refusals etc. (codes only) */
  warn?: (msg: string) => void;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

export async function status(d: AppDeps) {
  const s = d.updater.snapshot();
  return {
    updater: d.self,
    channel: s.channel, version: s.version, targetTag: channelTag(s.channel, s.version),
    current: s.current, previous: s.previous, busy: d.updater.busy,
    job: s.lastJob, log: d.updater.log.tail(30),
    services: await d.services().catch(() => []),
  };
}

export function handler(d: AppDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '').split('?')[0]!;
    if (path === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true });
    const r = ROUTES[path];
    if (!r) return send(res, 404, { error: 'not_found' });
    if (req.method !== r.method) return send(res, 405, { error: 'method_not_allowed' });
    const body = await readBody(req);
    if (body === null) return send(res, 413, { error: 'too_large' });
    const auth = verify(d.verifier, { method: req.method, path, headers: req.headers, body });
    if (!auth.ok) {
      d.warn?.(`refused ${r.route}: ${auth.error}`);
      return send(res, 401, { error: auth.error });
    }
    if (r.route === 'status') return send(res, 200, await status(d));
    if (r.route === 'channel') {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'json_required' });
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { return send(res, 400, { error: 'invalid_body' }); }
      const c = parseChannelBody(parsed);
      if (!c) return send(res, 400, { error: 'invalid_body' });
      if (d.updater.busy) return send(res, 409, { error: 'busy' });
      const s = d.updater.setChannel(c.channel, c.version);
      return send(res, 200, { channel: s.channel, version: s.version, targetTag: channelTag(s.channel, s.version) });
    }
    // the job actions take no parameters at all
    if (body !== '' && body.trim() !== '{}') return send(res, 400, { error: 'invalid_body' });
    const started = d.updater.start(r.route);
    if (!started.ok) return send(res, started.error === 'busy' ? 409 : 400, { error: started.error });
    return send(res, 202, { job: started.job });
  };
}

export function healthProbe(docker: Pick<Docker, 'ps'>, url: string, fetchImpl: typeof fetch = fetch): Ops['healthy'] {
  return async (sha7) => {
    const ps = await docker.ps();
    for (const svc of HEALTH_SERVICES) {
      const st = ps.find((p) => p.service === svc);
      if (!st || st.state !== 'running' || (st.health !== '' && st.health !== 'healthy')) return false;
    }
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(3_000), redirect: 'error' });
    if (!r.ok) return false;
    const b = (await r.json().catch(() => null)) as { version?: unknown } | null;
    return sha7 === null || b?.version === sha7;
  };
}

/** what each FriendFlix service runs; cached a few seconds (every status poll would otherwise cost several Docker calls) */
export function servicesView(docker: Pick<Docker, 'ps' | 'containerImage' | 'imageInfo'>, ttlMs = 10_000, now: () => number = Date.now): () => Promise<ServiceView[]> {
  let cache: { at: number; v: ServiceView[] } | null = null;
  return async () => {
    if (cache && now() - cache.at < ttlMs) return cache.v;
    const ps: ServiceState[] = await docker.ps();
    const v = await Promise.all([...FF_SERVICES, SELF_SERVICE].map(async (service) => {
      const st = ps.find((p) => p.service === service);
      const id = st ? await docker.containerImage(st.name) : null;
      const info: ImageInfo | null = id ? await docker.imageInfo(id) : null;
      return { service, state: st?.state ?? 'missing', health: st?.health ?? '', sha: shaTag(info?.gitSha), version: info?.version ?? null };
    }));
    cache = { at: now(), v };
    return v;
  };
}

export function start(env: NodeJS.ProcessEnv = process.env): Server {
  const cfg = loadConfig(env);
  const docker = new Docker({ projectDir: cfg.projectDir, files: cfg.composeFiles, projectName: cfg.projectName, repo: cfg.repo, dockerHost: cfg.dockerHost }, execRunner);
  const ops: Ops = {
    images: (t, s) => docker.images(t, s), pull: (t, s) => docker.pull(t, s), verify: (i) => docker.verify(i), up: (t, s) => docker.up(t, s),
    imageInfo: (r) => docker.imageInfo(r), running: (s) => docker.running(s), spawnSelfUpdate: (t) => docker.spawnSelfUpdate(t),
    healthy: healthProbe(docker, cfg.backendHealthUrl),
  };
  const updater = new Updater(ops, fileStore(cfg.stateDir));
  const verifier: Verifier = { key: deriveKey(cfg.secret), cache: new ReplayCache(), notBefore: Date.now() };
  const services = servicesView(docker);
  const log = (msg: string) => console.log(`${new Date().toISOString()} updater: ${msg}`);
  const app = handler({ updater, verifier, services, self: { version: cfg.version, sha: cfg.gitSha }, warn: log });
  const server = createServer((req, res) => { void app(req, res).catch(() => { if (!res.headersSent) send(res, 500, { error: 'internal' }); }); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.listen(cfg.port, '0.0.0.0', () => log(`listening on :${cfg.port} (project ${cfg.projectDir}, files ${cfg.composeFiles.join(',')}, repo ${cfg.repo})`));
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { server.close(); process.exit(0); });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) start();
