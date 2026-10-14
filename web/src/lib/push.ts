// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { api } from '#lib/api';

export type PushState = 'unsupported' | 'ios-install' | 'server-off' | 'denied' | 'off' | 'on';

export const pushSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;

export function isIosNonStandalone(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = (navigator as unknown as { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
  return ios && !standalone;
}

const b64urlToBytes = (s: string) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const bufToB64url = (b: ArrayBuffer | null) => (b ? btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '');

const registration = async () => navigator.serviceWorker.ready;
const current = async () => (await registration()).pushManager.getSubscription();

function body(sub: PushSubscription, broadcast?: boolean) {
  return { endpoint: sub.endpoint, keys: { p256dh: bufToB64url(sub.getKey('p256dh')), auth: bufToB64url(sub.getKey('auth')) }, broadcast };
}

/** Where this device stands; also tells whether the checkboxes can be used. */
export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return isIosNonStandalone() ? 'ios-install' : 'unsupported';
  const cfg = await api<{ enabled: boolean }>('/api/push/config').catch(() => ({ enabled: false }));
  if (!cfg.enabled) return 'server-off';
  if (Notification.permission === 'denied') return 'denied';
  return (await current().catch(() => null)) ? 'on' : 'off';
}

/** Must be called from a click handler (permission prompt). */
export async function enablePush(broadcast: boolean): Promise<PushState> {
  const cfg = await api<{ enabled: boolean; publicKey?: string }>('/api/push/config');
  if (!cfg.enabled || !cfg.publicKey) return 'server-off';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  const reg = await registration();
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(cfg.publicKey) as BufferSource }));
  await api('/api/push/subscribe', { method: 'POST', body: body(sub, broadcast) });
  return 'on';
}

export async function disablePush(): Promise<void> {
  const sub = await current().catch(() => null);
  if (!sub) return;
  await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}

export async function updateBroadcast(broadcast: boolean): Promise<void> {
  const sub = await current();
  if (sub) await api('/api/push/subscribe', { method: 'POST', body: body(sub, broadcast) });
}

export async function testPush(): Promise<{ sent: boolean; status?: number }> {
  const sub = await current();
  if (!sub) return { sent: false };
  return api('/api/push/test', { method: 'POST', body: { endpoint: sub.endpoint } });
}

/** Settings page load: re-registers the browser subscription with the server (it may have been revoked/rotated). */
export async function syncPush(): Promise<boolean | null> {
  if (!pushSupported() || Notification.permission !== 'granted') return null;
  const sub = await current().catch(() => null);
  if (!sub) return null;
  const r = await api<{ broadcast: boolean }>('/api/push/subscribe', { method: 'POST', body: body(sub) }).catch(() => null);
  return r ? r.broadcast : null;
}
