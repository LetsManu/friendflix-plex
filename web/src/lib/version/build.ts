// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the running backend build is (GET /api/version, backend/src/channel.ts): the release commit of its version or a
 * nightly build of main. The image is the same for both, so only the backend can tell (it looks the tag up on GitHub).
 * The footer asks once per page load; until the answer (and for older backends) it shows the version from version.json.
 */
import { writable } from 'svelte/store';

export type BuildKind = 'release' | 'nightly' | 'dev';
export type Channel = 'stable' | 'nightly';
export interface BuildInfo { sha: string; build: BuildKind | null; channel: Channel | null; label: string }

const KINDS: readonly string[] = ['release', 'nightly', 'dev'];

/** Lenient parse of /api/version; null when it carries no build information. */
export function parseBuild(raw: unknown): BuildInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const build = typeof r.build === 'string' && KINDS.includes(r.build) ? (r.build as BuildKind) : null;
  if (!build || typeof r.label !== 'string' || typeof r.sha !== 'string') return null;
  const channel = r.channel === 'stable' || r.channel === 'nightly' ? r.channel : null;
  return { sha: r.sha, build, channel, label: r.label };
}

/** "1.1.0-nightly · abc1234" for a nightly build, else "1.1.0 · Arancini" as before (a dev build and an unknown one too) */
export function versionText(version: string, codename: string, b: BuildInfo | null): string {
  if (b?.build === 'nightly' && b.label) return b.label;
  return codename ? `${version} · ${codename}` : version;
}

export const buildInfo = writable<BuildInfo | null>(null);
let asked = false;

/** fetches /api/version once (failures are silent: the footer keeps the version.json text) */
export function loadBuild(fetchImpl: typeof fetch = fetch): void {
  if (asked) return;
  asked = true;
  fetchImpl('/api/version', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => buildInfo.set(parseBuild(j)))
    .catch(() => undefined);
}
