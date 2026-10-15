// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin warning banner (Block 22): `GET /api/admin/health/banner` as a store (polled every 60 s while the tab is visible),
 * the worst issue first, one sentence per issue (Block 23: open approval requests too), and "Ausblenden" per issue until its level or reason changes (server-side).
 */
import { writable, type Readable } from 'svelte/store';
import { api } from '#lib/api';
import { hasKey, tr, type TKey } from '#lib/i18n';
import { poll } from '#lib/adminContent/poll';
import { errorText } from '#lib/ui/action';
import { toast } from '#lib/ui/toast';
import type { HealthIssue, Level } from './health';

export interface BannerState { issues: HealthIssue[]; worst: Level }
export interface BannerView { first: HealthIssue | null; rest: HealthIssue[]; more: number; level: 'warn' | 'err' | null }

/** worst first (err before warn, stable otherwise) */
export function bannerView(issues: readonly HealthIssue[]): BannerView {
  const sorted = [...issues.filter((i) => i.level === 'err'), ...issues.filter((i) => i.level !== 'err')];
  const first = sorted[0] ?? null;
  return { first, rest: sorted.slice(1), more: Math.max(0, sorted.length - 1), level: first ? first.level : null };
}

const nameOf = (key: string, fallback: string): string => (hasKey(key) ? tr(key as TKey) : fallback);

/** one sentence per issue ("Medienserver nicht erreichbar", "Download-Speicher fast voll (93 %)") */
export function issueText(i: HealthIssue): string {
  const [fam = '', sub = ''] = i.id.split(':');
  const params = { n: i.detail?.n ?? 0, pct: i.detail?.pct ?? 0, name: '' };
  let key = '';
  if (fam === 'svc') { key = `admin.banner.svc.${i.reason}`; params.name = nameOf(`adminContent.health.svc.${sub}`, sub); }
  else if (fam === 'disk') { key = `admin.banner.disk.${i.reason}`; params.name = nameOf(`admin.banner.name.${sub}`, sub); }
  else if (fam === 'errors') key = `admin.banner.errors.${i.reason}`;
  else if (fam === 'approvals') key = `admin.banner.approvals.${i.reason}`;
  return hasKey(key) ? tr(key as TKey, params) : tr('admin.banner.generic');
}

/** where "Ansehen" leads: the approval queue for open sign-in requests, the status page for everything else */
export const issueHref = (i: HealthIssue | null): string => (i?.id === 'approvals:pending' ? '/admin/users?tab=approvals' : '/admin/status');

const store = writable<BannerState | null>(null);
export const banner: Readable<BannerState | null> = { subscribe: store.subscribe };
/** test helper */
export const setBannerForTests = (s: BannerState | null): void => store.set(s);

let seq = 0;
/** loads the banner; a failure keeps the last state silently (the banner never shows an error of its own) */
export async function refreshBanner(): Promise<void> {
  const my = ++seq;
  try {
    const r = await api<BannerState>('/api/admin/health/banner');
    if (my === seq) store.set(r);
  } catch { /* keep the last state */ }
}

/** starts the 60 s poll (visible tab only, refresh when the tab comes back); returns the stop function */
export function startBanner(): () => void {
  void refreshBanner();
  return poll(refreshBanner, 60_000);
}

/** hides one issue at once and remembers the dismissal on the server; rolls back (with a toast) when that fails */
export async function dismiss(i: HealthIssue): Promise<boolean> {
  let prev = null as BannerState | null;
  seq++; // a refresh that is in flight must not bring the issue back
  store.update((s) => { prev = s; return s ? { ...s, issues: s.issues.filter((x) => x !== i && !(x.id === i.id && x.fp === i.fp)) } : s; });
  try {
    await api('/api/admin/health/dismiss', { method: 'POST', body: { id: i.id, fp: i.fp } });
    return true;
  } catch (e) {
    store.update((s) => (s && prev ? { ...s, issues: [...prev.issues] } : s));
    toast.error(errorText(e));
    return false;
  }
}
