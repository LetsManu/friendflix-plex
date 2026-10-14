// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { BRAND_NAME } from '../brand';
/** Web Push handlers for the service worker. Kept free of the webworker lib so it type-checks next to the DOM lib. */
interface PushClient { url: string; focus(): Promise<unknown>; navigate?(url: string): Promise<unknown>; postMessage(m: unknown): void }
interface SwScope {
  location: { origin: string };
  registration: { showNotification(title: string, o?: Record<string, unknown>): Promise<void>; getNotifications?(): Promise<unknown[]> };
  navigator?: { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  clients: { matchAll(o: Record<string, unknown>): Promise<PushClient[]>; openWindow(url: string): Promise<unknown> };
  addEventListener(type: string, fn: (e: any) => void): void;
}

/** Same-origin relative link from a push payload, else null. */
export function safeLink(link: unknown, origin: string): string | null {
  if (typeof link !== 'string' || !/^\/(?!\/)/.test(link)) return null;
  try {
    const u = new URL(link, origin);
    return u.origin === origin ? u.pathname + u.search + u.hash : null;
  } catch { return null; }
}

/** App icon badge from the service worker: the number of notifications still showing (best effort, silently skipped where unsupported). */
export async function updateBadge(s: Pick<SwScope, 'registration' | 'navigator'>): Promise<void> {
  try {
    const nav = s.navigator;
    if (!nav?.setAppBadge) return;
    const n = (await s.registration.getNotifications?.())?.length ?? 0;
    if (n > 0) await nav.setAppBadge(Math.min(99, n)); else await nav.clearAppBadge?.();
  } catch { /* badge is a nicety */ }
}

export function installPush(sw: unknown): void {
  const s = sw as SwScope;
  s.addEventListener('push', (e) => {
    let d: { title?: unknown; body?: unknown; link?: unknown; tag?: unknown } = {};
    try { d = e.data ? e.data.json() : {}; } catch { try { d = { body: e.data?.text() }; } catch { /* ignore */ } }
    if (!d || typeof d !== 'object') d = {};
    const title = typeof d.title === 'string' && d.title ? d.title.slice(0, 120) : BRAND_NAME;
    const link = safeLink(d.link, s.location.origin) ?? '/';
    e.waitUntil(s.registration.showNotification(title, {
      body: typeof d.body === 'string' ? d.body.slice(0, 300) : '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: typeof d.tag === 'string' ? d.tag : undefined,
      data: { link },
    }).then(() => updateBadge(s)));
  });
  s.addEventListener('notificationclick', (e) => {
    e.notification.close();
    const link = safeLink(e.notification.data?.link, s.location.origin) ?? '/';
    e.waitUntil(updateBadge(s)); // the clicked notification is closed: recount
    const url = new URL(link, s.location.origin).toString();
    e.waitUntil((async () => {
      const wins = await s.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const w = wins.find((c) => new URL(c.url).origin === s.location.origin);
      if (w) {
        await w.focus().catch(() => undefined);
        if (w.navigate) { try { await w.navigate(url); return; } catch { /* fall through to message */ } }
        w.postMessage({ type: 'ff-nav', link });
        return;
      }
      await s.clients.openWindow(url);
    })());
  });
}
