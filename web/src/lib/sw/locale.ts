// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The UI language for the service worker: the page stores it in a small cache (Cache Storage is shared with the worker,
 * localStorage is not). The worker reads it on install and precaches that language's chunks (service-worker/precache.ts).
 */
export const META_CACHE = 'ff-meta';
export const LOCALE_URL = '/__ff/locale';

/** Page side: remember the active language (best effort; no Cache Storage → nothing happens). */
export async function rememberOfflineLocale(lang: string): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const c = await caches.open(META_CACHE);
    await c.put(LOCALE_URL, new Response(lang, { headers: { 'content-type': 'text/plain' } }));
  } catch { /* private mode / storage blocked */ }
}

/** Worker side: the remembered language, or null. */
export async function offlineLocale(): Promise<string | null> {
  try {
    const c = await caches.open(META_CACHE);
    const r = await c.match(LOCALE_URL);
    const v = r ? (await r.text()).trim() : '';
    return /^[a-z]{2}$/.test(v) ? v : null;
  } catch { return null; }
}
