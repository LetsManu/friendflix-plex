/**
 * What the service worker stores on install: only the app shell the offline hub needs (the prerendered /offline page,
 * the modules and stylesheets it references, the latin Inter subset and the icons). Every other immutable file
 * (route chunks, other font subsets) is cached on first use (cache-first), so a first visit no longer downloads the whole app twice.
 */

/** absolute `/_app/immutable/…` URLs referenced by a prerendered page (module preloads, stylesheets, the hydration import) */
export function shellUrls(html: string): string[] {
  const out = new Set<string>();
  const add = (p: string) => out.add('/' + p.replace(/^\.?\//, ''));
  for (const m of html.matchAll(/\b(?:href|src)="((?:\.?\/)?_app\/immutable\/[^"?#]+)"/g)) add(m[1]!);
  for (const m of html.matchAll(/import\(\s*["']((?:\.?\/)?_app\/immutable\/[^"'?#]+)["']\s*\)/g)) add(m[1]!);
  return [...out];
}

/** the Inter subset German text needs (the others load on demand through unicode-range) */
export const isShellFont = (path: string) => /\/inter-latin-wght-normal\.[\w-]+\.woff2$/.test(path);

/** files to put into the cache on install, before reading the /offline page */
export function basePrecache(o: { immutable: string[]; prerendered: string[]; statics: string[] }): string[] {
  return [...new Set([...o.prerendered, ...o.statics, ...o.immutable.filter(isShellFont)])];
}

/**
 * Language chunks for offline use. The build writes `/_app/locales.json` ({ "en": ["/_app/immutable/chunks/x.js", …], … }:
 * the chunk of each `lib/i18n/locales/<lang>/index.ts` plus its own imports); the page remembers its UI language in the
 * `ff-meta` cache (lib/sw/locale.ts) and the service worker precaches that language's chunks on install, so /offline renders
 * in the stored language without network. German is bundled with the app and never listed.
 */
export const LOCALE_MANIFEST = '/_app/locales.json';

interface ChunkLike { type: string; fileName: string; facadeModuleId?: string | null; imports?: string[] }

/** Builds the locale manifest from a Rollup/Rolldown client bundle (only `_app/immutable/` chunks; null when there are none). */
export function localeManifest(bundle: Record<string, ChunkLike>): Record<string, string[]> | null {
  const out: Record<string, string[]> = {};
  for (const c of Object.values(bundle)) {
    if (c.type !== 'chunk' || !c.fileName.startsWith('_app/immutable/')) continue;
    const m = /[\\/]lib[\\/]i18n[\\/]locales[\\/]([a-z]{2})[\\/]index\.ts$/.exec(c.facadeModuleId ?? '');
    if (!m || m[1] === 'de') continue;
    out[m[1]!] = [...new Set([c.fileName, ...(c.imports ?? [])])].map((f) => '/' + f);
  }
  return Object.keys(out).length ? out : null;
}

/** URLs to precache for `lang` (only files of this build, i.e. listed in `known`). */
export function localeUrls(manifest: unknown, lang: string | null | undefined, known: Set<string>): string[] {
  if (!lang || lang === 'de' || !manifest || typeof manifest !== 'object') return [];
  const list = (manifest as Record<string, unknown>)[lang];
  return Array.isArray(list) ? list.filter((u): u is string => typeof u === 'string' && known.has(u)) : [];
}
