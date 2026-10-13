import { readFileSync } from 'node:fs';

/**
 * Release codenames, one per MAJOR version in alphabetical order (1 = Arancini, 2 = Brezel, …).
 * Mirrors /codenames.json (the source used by scripts/release.mjs and the web app); test/version.test.ts keeps them equal.
 */
export const CODENAMES = [
  'Arancini', 'Brezel', 'Churros', 'Donut', 'Éclair', 'Fudge', 'Gummibär', 'Hotdog', 'Ingwerkeks', 'Jellybean', 'Karamell', 'Lakritz', 'Marshmallow',
  'Nachos', 'Onionring', 'Popcorn', 'Quarkbällchen', 'Reiswaffel', 'Softeis', 'Toffee', 'Ube', 'Vanilleeis', 'Waffel', 'Xocolatl', 'Yuzu', 'Zimtschnecke',
] as const;

export interface AppVersion { version: string; codename: string }

/** "1.2.3" or "v1.2.3" → [1, 2, 3]; null for anything else (pre-releases are not used here) */
export function parseSemver(v: string | null | undefined): [number, number, number] | null {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** <0 when a is older than b, 0 when equal, >0 when newer; unparsable versions sort first */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** codename of a version's major line (null outside the list, e.g. 0.x) */
export const codenameFor = (version: string): string | null => {
  const p = parseSemver(version);
  return p && p[0] >= 1 ? (CODENAMES[p[0] - 1] ?? null) : null;
};

let fromFile: AppVersion | null | undefined;
/** version.json at the repo root (also copied into the images); read once */
function versionFile(): AppVersion | null {
  if (fromFile !== undefined) return fromFile;
  try {
    const j = JSON.parse(readFileSync(new URL('../../version.json', import.meta.url), 'utf8')) as Partial<AppVersion>;
    fromFile = parseSemver(j.version) ? { version: j.version!, codename: j.codename || codenameFor(j.version!) || '' } : null;
  } catch {
    fromFile = null;
  }
  return fromFile;
}

/** installed version: APP_VERSION / APP_CODENAME (baked into the image at build time), else version.json, else 0.0.0 */
export function appVersion(cfg: { APP_VERSION?: string | undefined; APP_CODENAME?: string | undefined }): AppVersion {
  const v = cfg.APP_VERSION?.replace(/^v/, '');
  if (v && parseSemver(v)) return { version: v, codename: cfg.APP_CODENAME || codenameFor(v) || '' };
  return versionFile() ?? { version: '0.0.0', codename: '' };
}
