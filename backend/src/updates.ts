// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
import { appVersion, codenameFor, compareSemver, parseSemver } from './version.js';

const TTL = 600;
const CACHE_MS = 'update:info:';
const GH = 'https://api.github.com';

export interface Latest { sha: string; date: string; runUrl: string }
export interface CommitInfo { sha: string; message: string; author: string; date: string; url: string }
/** newest published GitHub release (releases/latest) */
export interface Release { version: string; codename: string | null; tag: string; name: string; url: string; publishedAt: string | null; notes: string }
export interface UpdateInfo {
  current: { sha: string; builtAt: string | null; version: string; codename: string };
  /** newest release; null when none is published yet (or its tag is not a version) */
  release: Release | null;
  /** release-based answer; null = nothing to compare with, fall back to `behind` */
  updateAvailable: boolean | null;
  /** secondary: newest successful CI build on main and how many commits it is ahead of the installed build */
  latest: Latest | null;
  behind: number | null;
  commits: CommitInfo[];
  portainer: { configured: boolean; mode: 'webhook' | 'api' | null };
  autoUpdateNote: true;
  error?: string;
}

export function portainerMode(ctx: Ctx): 'webhook' | 'api' | null {
  const c = ctx.cfg;
  if (c.PORTAINER_WEBHOOK_URL) return 'webhook';
  if (c.PORTAINER_URL && c.PORTAINER_API_KEY && c.PORTAINER_STACK_ID) return 'api';
  return null;
}

/** GitHub GET; `null` for a 404 when `missingOk` (e.g. no release published yet) */
async function gh<T>(ctx: Ctx, path: string, missingOk = false): Promise<T | null> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'friendflix' };
  if (ctx.cfg.GITHUB_TOKEN) headers.authorization = `Bearer ${ctx.cfg.GITHUB_TOKEN}`;
  const r = await ctx.fetchImpl(`${GH}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
  if (missingOk && r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return (await r.json()) as T;
}

type Fetched = Pick<UpdateInfo, 'release' | 'latest' | 'behind' | 'commits'>;
const NOTES_MAX = 20_000;

async function fetchRelease(ctx: Ctx): Promise<Release | null> {
  const r = await gh<{ tag_name?: string; name?: string | null; html_url?: string; published_at?: string | null; body?: string | null; draft?: boolean; prerelease?: boolean }>(ctx, `/repos/${ctx.cfg.UPDATE_REPO}/releases/latest`, true);
  const tag = r?.tag_name ?? '';
  if (!r || r.draft || r.prerelease || !parseSemver(tag)) return null;
  const version = tag.replace(/^v/, '');
  return { version, codename: codenameFor(version), tag, name: r.name || tag, url: r.html_url ?? '', publishedAt: r.published_at ?? null, notes: (r.body ?? '').slice(0, NOTES_MAX) };
}

async function fetchMain(ctx: Ctx): Promise<Pick<Fetched, 'latest' | 'behind' | 'commits'> | null> {
  const repo = ctx.cfg.UPDATE_REPO;
  const runs = await gh<{ workflow_runs?: Array<{ head_sha: string; updated_at: string; html_url: string }> }>(ctx, `/repos/${repo}/actions/workflows/ci.yml/runs?branch=main&status=success&event=push&per_page=1`);
  const run = runs?.workflow_runs?.[0];
  if (!run) return null;
  const latest: Latest = { sha: run.head_sha, date: run.updated_at, runUrl: run.html_url };
  const cur = ctx.cfg.GIT_SHA;
  if (cur === 'dev' || cur === latest.sha) return { latest, behind: cur === latest.sha ? 0 : null, commits: [] };
  try {
    const cmp = (await gh<{ ahead_by: number; commits?: Array<{ sha: string; html_url: string; commit: { message: string; author?: { name?: string; date?: string } }; author?: { login?: string } | null }> }>(ctx, `/repos/${repo}/compare/${cur}...${latest.sha}`))!;
    const commits = (cmp.commits ?? []).slice(-50).reverse().map((c) => ({
      sha: c.sha, message: c.commit.message.split('\n')[0]!, author: c.commit.author?.name ?? c.author?.login ?? '', date: c.commit.author?.date ?? '', url: c.html_url,
    }));
    return { latest, behind: cmp.ahead_by, commits };
  } catch {
    return { latest, behind: null, commits: [] }; // unknown/rebased current sha: still show the latest version
  }
}

async function fetchLatest(ctx: Ctx): Promise<Fetched> {
  const [release, main] = await Promise.all([fetchRelease(ctx), fetchMain(ctx)]);
  if (!release && !main) throw new Error('no release and no successful CI run found');
  return { release, ...(main ?? { latest: null, behind: null, commits: [] }) };
}

/**
 * Installed vs newest release (primary) and vs the newest CI build on main (secondary: commits ahead, also the only
 * comparison before the first release). GitHub answers are cached for 10 min (unauthenticated limit: 60/h); an outage never throws.
 */
export async function updateInfo(ctx: Ctx, refresh = false): Promise<UpdateInfo> {
  const mode = portainerMode(ctx);
  const ver = appVersion(ctx.cfg);
  const base = { current: { sha: ctx.cfg.GIT_SHA, builtAt: ctx.cfg.BUILD_TIME ?? null, ...ver }, portainer: { configured: mode !== null, mode }, autoUpdateNote: true as const };
  const withState = (f: Fetched): UpdateInfo => ({ ...base, ...f, updateAvailable: f.release ? compareSemver(f.release.version, ver.version) > 0 : null });
  const key = `${CACHE_MS}${ctx.cfg.UPDATE_REPO}:${ctx.cfg.GIT_SHA}:${ver.version}`;
  if (!refresh) {
    const hit = await ctx.kv.get(key).catch(() => null);
    if (hit) return withState(JSON.parse(hit) as Fetched);
  }
  try {
    const f = await fetchLatest(ctx);
    await ctx.kv.set(key, JSON.stringify(f), TTL).catch(() => undefined);
    return withState(f);
  } catch (e) {
    return { ...base, release: null, updateAvailable: null, latest: null, behind: null, commits: [], error: e instanceof Error && e.message.startsWith('GitHub ') ? e.message : 'github_unreachable' };
  }
}

export type TriggerResult = { ok: true; mode: 'webhook' | 'api' } | { ok: false; status: number | null; error: string; step: 'webhook' | 'stack' | 'stack_file' | 'redeploy'; code?: string };

/**
 * Starts the redeploy. The final call is raced against a short grace window: Portainer may recreate (= kill) this very
 * container while still answering, so a call that is merely slow counts as started; only a fast failure is reported.
 */
export async function triggerUpdate(ctx: Ctx, mode: 'webhook' | 'api'): Promise<TriggerResult> {
  const timeout = () => AbortSignal.timeout(30_000);
  const send = async (url: string, init: RequestInit): Promise<Response | 'pending'> => {
    const p = ctx.fetchImpl(url, { ...init, signal: timeout() });
    p.catch(() => undefined); // a late failure after we returned must not become an unhandled rejection
    return Promise.race([p, new Promise<'pending'>((res) => setTimeout(res, 5000, 'pending').unref())]);
  };
  const fail = (status: number | null, error: string, step: 'webhook' | 'stack' | 'stack_file' | 'redeploy'): TriggerResult => ({ ok: false, status, error, step });
  let step: 'webhook' | 'stack' | 'stack_file' | 'redeploy' = mode === 'webhook' ? 'webhook' : 'stack';
  try {
    if (mode === 'webhook') {
      const r = await send(ctx.cfg.PORTAINER_WEBHOOK_URL!, { method: 'POST' });
      return r !== 'pending' && !r.ok ? fail(r.status, 'portainer', step) : { ok: true, mode };
    }
    const base = ctx.cfg.PORTAINER_URL!.replace(/\/+$/, '');
    const id = encodeURIComponent(ctx.cfg.PORTAINER_STACK_ID!);
    const eid = `endpointId=${ctx.cfg.PORTAINER_ENDPOINT_ID}`;
    const headers = { 'x-api-key': ctx.cfg.PORTAINER_API_KEY! };
    const getJson = async <T>(path: string): Promise<T | number> => {
      const r = await ctx.fetchImpl(`${base}${path}`, { headers, signal: timeout() });
      return r.ok ? ((await r.json()) as T) : r.status;
    };
    const stack = await getJson<{ Env?: unknown[] | null; GitConfig?: { ReferenceName?: string } | null }>(`/api/stacks/${id}`);
    if (typeof stack === 'number') return fail(stack, 'portainer', step);
    const env = stack.Env ?? []; // passed back unchanged: Portainer replaces the stack env with what we send
    let r: Response | 'pending';
    step = 'redeploy';
    if (stack.GitConfig) {
      r = await send(`${base}/api/stacks/${id}/git/redeploy?${eid}`, {
        method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ repositoryReferenceName: stack.GitConfig.ReferenceName, env, prune: false, pullImage: true, repullImageAndRedeploy: true }),
      });
    } else {
      step = 'stack_file';
      const file = await getJson<{ StackFileContent?: string }>(`/api/stacks/${id}/file`);
      if (typeof file === 'number') return fail(file, 'portainer', step);
      step = 'redeploy';
      r = await send(`${base}/api/stacks/${id}?${eid}`, {
        method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ stackFileContent: file.StackFileContent, env, prune: false, pullImage: true, repullImageAndRedeploy: true }),
      });
    }
    return r !== 'pending' && !r.ok ? fail(r.status, 'portainer', step) : { ok: true, mode };
  } catch (e) {
    // never include the message: node puts the request URL (webhook token) in it; the errno code alone is safe and tells DNS from firewall
    const raw = (e as { cause?: { code?: unknown }; name?: unknown })?.cause?.code ?? ((e as { name?: unknown })?.name === 'TimeoutError' ? 'ETIMEDOUT' : undefined);
    const code = typeof raw === 'string' && /^[A-Z_]{2,40}$/.test(raw) ? raw : undefined;
    return { ...fail(null, 'portainer_unreachable', step), ...(code ? { code } : {}) } as TriggerResult;
  }
}
