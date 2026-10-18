// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from './ctx.js';
import { appVersion } from './version.js';

/**
 * Update channels (docs/operations.md "Release-Kanäle"). The images decide what runs: `FF_TAG=latest` follows the releases
 * (stable), `FF_TAG=nightly` every green commit on main, `FF_TAG=X.Y.Z` a fixed version (pinned). The backend never gets the
 * Docker socket: without the opt-in updater (updater.ts) the UPDATE_CHANNEL setting only chooses what Admin -> Update compares
 * against and which `.env` line it suggests; with it, the updater installs that channel's tag. The channel a build actually runs is derived from its commit: a release build is exactly the commit of
 * the tag v<version> (the image is re-tagged, never rebuilt, so the sha is the same); any other CI build is a nightly one.
 */
export type Channel = 'stable' | 'nightly' | 'pinned';
/** a channel a build can run on (a pinned version is a release, so it runs on stable) */
export type RunningChannel = 'stable' | 'nightly';
/** release = the commit of tag v<version>; nightly = another CI image build; dev = a local build without a commit sha */
export type BuildKind = 'release' | 'nightly' | 'dev';

const TTL = 600;
const ERR_TTL = 60;
const GH = 'https://api.github.com';

/** CI bakes the full commit sha into the image (GIT_SHA build arg); local builds carry 'dev' */
export const isCiSha = (sha: string | null | undefined): boolean => /^[0-9a-f]{40}$/.test(String(sha ?? ''));

/** `tagSha`: the commit of tag v<version>; null = no such tag; undefined = unknown (GitHub not reachable) -> null */
export function buildKind(sha: string, tagSha: string | null | undefined): BuildKind | null {
  if (!isCiSha(sha)) return 'dev';
  if (tagSha === undefined) return null;
  return tagSha === sha ? 'release' : 'nightly';
}

/** the channel a build kind belongs to; a dev build belongs to none */
export const runningChannel = (kind: BuildKind | null): RunningChannel | null => (kind === 'release' ? 'stable' : kind === 'nightly' ? 'nightly' : null);

/** "1.1.0" for a release, a dev build and when unknown; "1.1.0-nightly · abc1234" for a nightly build */
export function versionLabel(version: string, sha: string, kind: BuildKind | null): string {
  return kind === 'nightly' ? `${version}-nightly · ${sha.slice(0, 7)}` : version;
}

/**
 * Is there an update on this channel? stable: a newer release than the installed version (null before the first release).
 * nightly: newer commits on main than the installed sha (null when unknown). pinned: a different version than the installed one
 * (null without a version).
 */
export function channelUpdate(channel: Channel, s: { releaseNewer: boolean | null; behind: number | null; pinnedDiffers?: boolean | null }): boolean | null {
  if (channel === 'stable') return s.releaseNewer;
  if (channel === 'pinned') return s.pinnedDiffers ?? null;
  return s.behind === null ? null : s.behind > 0;
}

/** the `.env` line that selects a channel (compose.prod.yaml: image tag ${FF_TAG:-latest}); pinned without a version: the stable line */
export const envLine = (channel: Channel, version?: string | null): string =>
  `FF_TAG=${channel === 'nightly' ? 'nightly' : channel === 'pinned' && version ? version : 'latest'}`;

async function ghJson<T>(ctx: Ctx, path: string): Promise<T | null> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'friendflix' };
  if (ctx.cfg.GITHUB_TOKEN) headers.authorization = `Bearer ${ctx.cfg.GITHUB_TOKEN}`;
  const r = await ctx.fetchImpl(`${GH}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return (await r.json()) as T;
}

/** commit sha of tag v<version> (annotated tags are peeled); null when the tag does not exist */
async function fetchTagCommit(ctx: Ctx, version: string): Promise<string | null> {
  const repo = ctx.cfg.UPDATE_REPO;
  type Ref = { object?: { type?: string; sha?: string } };
  const ref = await ghJson<Ref>(ctx, `/repos/${repo}/git/ref/tags/v${encodeURIComponent(version)}`);
  let obj = ref?.object;
  for (let i = 0; obj?.type === 'tag' && obj.sha && i < 3; i++) obj = (await ghJson<Ref>(ctx, `/repos/${repo}/git/tags/${obj.sha}`))?.object;
  return obj?.type === 'commit' && obj.sha ? obj.sha : null;
}

const inflight = new Map<string, Promise<string | null | undefined>>();

/**
 * The tag commit of the installed version, cached like the update check (10 min in Redis; a failure for 1 min, so an outage
 * does not cost one GitHub call per request). undefined = unknown.
 */
export async function tagCommit(ctx: Ctx, version: string, refresh = false): Promise<string | null | undefined> {
  const key = `update:tag:${ctx.cfg.UPDATE_REPO}:v${version}`;
  if (!refresh) {
    const hit = await ctx.kv.get(key).catch(() => null);
    if (hit) {
      const v = JSON.parse(hit) as { sha?: string | null; error?: true };
      return v.error ? undefined : (v.sha ?? null);
    }
  }
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    try {
      const sha = await fetchTagCommit(ctx, version);
      await ctx.kv.set(key, JSON.stringify({ sha }), TTL).catch(() => undefined);
      return sha;
    } catch {
      await ctx.kv.set(key, JSON.stringify({ error: true }), ERR_TTL).catch(() => undefined);
      return undefined;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export interface BuildInfo { sha: string; version: string; codename: string; build: BuildKind | null; channel: RunningChannel | null; label: string }

/**
 * What this build is. A dev build asks GitHub nothing. `waitMs` bounds the wait for an uncached GitHub answer (the public
 * /api/version is polled during an update): when it runs out the answer says "unknown" and the lookup finishes in the background.
 */
export async function buildInfo(ctx: Ctx, opts: { refresh?: boolean; waitMs?: number } = {}): Promise<BuildInfo> {
  const sha = ctx.cfg.GIT_SHA;
  const ver = appVersion(ctx.cfg);
  let tag: string | null | undefined;
  if (isCiSha(sha)) {
    const lookup = tagCommit(ctx, ver.version, opts.refresh);
    tag = opts.waitMs === undefined ? await lookup
      : await Promise.race([lookup, new Promise<undefined>((res) => setTimeout(res, opts.waitMs, undefined).unref())]);
  }
  const build = buildKind(sha, tag);
  return { sha, ...ver, build, channel: runningChannel(build), label: versionLabel(ver.version, sha, build) };
}
