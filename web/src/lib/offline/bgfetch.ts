// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Background Fetch (Chromium on Android/desktop): the browser downloads the video itself, with a system progress
// notification, and keeps going when the app is closed. The service worker (lib/sw/bgfetch.ts) stores the result.
// No Range support: a Background Fetch always starts from byte 0.

/** message the service worker posts to open pages after it changed a download record */
export interface BgMessage { type: 'ff-dl'; id: string }

export const bgTag = (id: string): string => `ff-dl-${id}`;
/** Chromium fails a fetch whose body exceeds downloadTotal; the licence size can be an estimate, so leave room */
export const bgTotal = (bytes: number): number => Math.ceil(bytes * 1.1);

async function manager(): Promise<any | null> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    return (reg as any)?.backgroundFetch ?? null;
  } catch { return null; }
}

export async function bgSupported(): Promise<boolean> {
  return (await manager()) !== null;
}

/** started: a new fetch; running: one for this download exists already (other tab, reload); failed: use the worker */
export async function startBg(id: string, url: string, opts: { title: string; total: number; icon?: string }): Promise<'started' | 'running' | 'failed'> {
  const bf = await manager();
  if (!bf) return 'failed';
  try {
    if (await bf.get(bgTag(id))) return 'running';
    await bf.fetch(bgTag(id), [url], {
      title: opts.title,
      icons: opts.icon ? [{ src: opts.icon, sizes: '192x192', type: 'image/png' }] : [],
      ...(opts.total > 0 ? { downloadTotal: bgTotal(opts.total) } : {}),
    });
    return 'started';
  } catch { return 'failed'; }
}

/** follow the progress of a running fetch; false when there is none (finished, failed or never started) */
export async function watchBg(id: string, onProgress: (downloaded: number) => void): Promise<boolean> {
  const bf = await manager();
  const r = bf ? await bf.get(bgTag(id)).catch(() => undefined) : undefined;
  if (!r) return false;
  onProgress(r.downloaded ?? 0);
  r.addEventListener('progress', () => onProgress(r.downloaded ?? 0));
  return true;
}

export async function abortBg(id: string): Promise<void> {
  const bf = await manager();
  try { await (await bf?.get(bgTag(id)))?.abort(); } catch { /* gone already */ }
}

/** records changed by the service worker (done, failed, chained next) */
export function onBgMessage(cb: (id: string) => void): void {
  navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as BgMessage | undefined;
    if (m?.type === 'ff-dl' && typeof m.id === 'string') cb(m.id);
  });
}
