// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure offline-licence logic (no browser APIs, unit-tested). Used by the download manager and the offline player.
// Honest limits: there is no DRM; expiry/revocation is enforced by the app, on the next online check-in.

import type { TKey } from '#lib/i18n';

export type TimeValue = number | string; // epoch ms or ISO string (server sends ISO, IndexedDB stores whatever the manager normalised to)

export interface LicenseFields {
  state: string;
  expiresAt: TimeValue;
  validUntil: TimeValue;
}
export interface LicenseMeta { maxSeenTime: number }

export type BlockReason = 'not_done' | 'expired' | 'checkin' | 'clock';
export interface Playable { ok: boolean; reason?: BlockReason }

/** allowed backwards clock skew before we assume the user turned the clock back */
export const CLOCK_TOLERANCE_MS = 3_600_000;

export const toMs = (t: TimeValue | null | undefined): number => {
  if (typeof t === 'number') return t;
  if (!t) return 0;
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : 0;
};

/**
 * May this download be played right now?
 * - must be fully downloaded
 * - clock guard: now far before the highest time we ever saw means the clock was turned back -> block until online check-in
 * - past expiresAt -> expired
 * - past validUntil (offline grace) -> an online check-in is required first
 */
export function isPlayable(dl: LicenseFields, now: number, meta: LicenseMeta | null | undefined): Playable {
  if (dl.state !== 'done') return { ok: false, reason: dl.state === 'expired' ? 'expired' : 'not_done' };
  if (meta && meta.maxSeenTime > 0 && now < meta.maxSeenTime - CLOCK_TOLERANCE_MS) return { ok: false, reason: 'clock' };
  if (now > toMs(dl.expiresAt)) return { ok: false, reason: 'expired' };
  if (now > toMs(dl.validUntil)) return { ok: false, reason: 'checkin' };
  return { ok: true };
}

/** message key per block reason (account.downloads.reason.*) */
export const REASON_KEY: Record<BlockReason, TKey> = {
  not_done: 'account.downloads.reason.notDone',
  expired: 'account.downloads.reason.expired',
  checkin: 'account.downloads.reason.checkin',
  clock: 'account.downloads.reason.clock',
};

/** whole days left until expiresAt (0 when expired) */
export const daysLeft = (expiresAt: TimeValue, now: number): number => Math.max(0, Math.ceil((toMs(expiresAt) - now) / 86_400_000));

/** meta.maxSeenTime only ever grows */
export const bumpMaxSeen = (prev: number, now: number): number => Math.max(prev, now);
