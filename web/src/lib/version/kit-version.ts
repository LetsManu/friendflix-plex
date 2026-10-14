// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * SvelteKit's `version.name` (`$app/env` version: service worker cache name, telemetry release, `_app/version.json`).
 * SvelteKit defaults it to `Date.now()`, which makes every build differ. For reproducible images it is derived from the
 * build inputs instead: the git commit (GIT_SHA build arg), else SOURCE_DATE_EPOCH (commit timestamp), else the clock
 * (plain local `vite build` / `vite dev` without either).
 */
export function kitVersionName(env: Record<string, string | undefined>, now: () => number = Date.now): string {
  const sha = env.GIT_SHA?.trim();
  if (sha && sha !== 'dev') return sha;
  const epoch = env.SOURCE_DATE_EPOCH?.trim();
  if (epoch && /^\d+$/.test(epoch)) return epoch;
  return now().toString();
}
