// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Everything the updater may touch, as constants. No request can name a service, an image, a command or an argument: the
 * actions are fixed, the tag comes from a channel (or a strictly checked X.Y.Z / recorded sha-<7 hex>), and the image names
 * are checked against the repository whose CI signature cosign requires.
 */

/** FriendFlix services the updater pulls and recreates (bootstrap: the init container on the backend image). Never the
 *  database, Redis, the media server, the request service or Authentik. */
export const FF_SERVICES = ['bootstrap', 'backend', 'gateway', 'web'] as const;
/** the services whose health decides success (bootstrap only runs once and exits) */
export const HEALTH_SERVICES = ['backend', 'gateway', 'web'] as const;
/** the updater's own service (explicit self-update only) */
export const SELF_SERVICE = 'updater';
/** service -> the image it runs (friendflix-<image>) */
export const IMAGE_OF: Readonly<Record<string, string>> = { bootstrap: 'backend', backend: 'backend', gateway: 'gateway', web: 'web', updater: 'updater' };

export type Channel = 'stable' | 'nightly' | 'pinned';
export const CHANNELS: readonly Channel[] = ['stable', 'nightly', 'pinned'];
export const VERSION_RE = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;
/** the short-sha tag publish.yml adds to every promoted image (docker/metadata-action type=sha, format=short) */
export const SHA_TAG_RE = /^sha-[0-9a-f]{7}$/;
/** every tag the updater can ever hand to compose */
export const TAG_RE = /^(latest|nightly|(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})|sha-[0-9a-f]{7})$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;

export function isTag(t: unknown): t is string {
  return typeof t === 'string' && TAG_RE.test(t);
}

/** stable -> latest, nightly -> nightly, pinned -> X.Y.Z (null when the version is missing or malformed) */
export function channelTag(channel: Channel, version?: string | null): string | null {
  if (channel === 'stable') return 'latest';
  if (channel === 'nightly') return 'nightly';
  return typeof version === 'string' && VERSION_RE.test(version) ? version : null;
}

/** the sha-<7> tag of a full commit sha baked into an image (GIT_SHA); null for a dev build or anything else */
export function shaTag(gitSha: string | null | undefined): string | null {
  return typeof gitSha === 'string' && GIT_SHA_RE.test(gitSha) ? `sha-${gitSha.slice(0, 7)}` : null;
}

/** Parses a channel request body: exactly {channel} or {channel: 'pinned', version}; anything else (extra keys too) is refused. */
export function parseChannelBody(raw: unknown): { channel: Channel; version: string | null } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o);
  if (!keys.every((k) => k === 'channel' || k === 'version')) return null;
  if (typeof o.channel !== 'string' || !(CHANNELS as readonly string[]).includes(o.channel)) return null;
  const channel = o.channel as Channel;
  if (channel === 'pinned') return typeof o.version === 'string' && VERSION_RE.test(o.version) ? { channel, version: o.version } : null;
  return 'version' in o ? null : { channel, version: null };
}

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export function isRepo(r: unknown): r is string {
  return typeof r === 'string' && REPO_RE.test(r) && !r.includes('..');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** ghcr.io/<owner>/<repo>-<image>:<tag> for this repository (GHCR names are lowercase; publish.yml does the same) */
export function expectedImage(repo: string, service: string, tag: string): string {
  const [owner, name] = repo.toLowerCase().split('/') as [string, string];
  return `ghcr.io/${owner}/${name}-${IMAGE_OF[service]}:${tag}`;
}

/** the image repository (without tag) */
export const imageRepo = (image: string): string => image.slice(0, image.lastIndexOf(':'));

/**
 * cosign keyless identity: the publish workflow of this repository, run on main or on a release tag, with GitHub's OIDC issuer.
 * publish.yml is a reusable workflow, so the certificate names it (not ci.yml).
 */
export function cosignIdentity(repo: string): { identityRegexp: string; issuer: string } {
  return {
    identityRegexp: `^https://github\\.com/${escapeRe(repo)}/\\.github/workflows/publish\\.yml@refs/(heads/main|tags/v[0-9]+\\.[0-9]+\\.[0-9]+)$`,
    issuer: 'https://token.actions.githubusercontent.com',
  };
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/** the repo@sha256 reference cosign verifies; null unless it is exactly the expected repository with a sha256 digest */
export function pinnedRef(image: string, repoDigests: readonly string[]): string | null {
  const repo = imageRepo(image);
  for (const d of repoDigests) {
    const at = d.lastIndexOf('@');
    if (at > 0 && d.slice(0, at) === repo && DIGEST_RE.test(d.slice(at + 1))) return d;
  }
  return null;
}
