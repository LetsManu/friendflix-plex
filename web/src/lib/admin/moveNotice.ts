// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "FriendFlix for Plex has moved" notice for admins: the fork gets no more features, FriendFlix 2.0 supports Plex itself.
 * Shown like the health banner (admins on the owner profile only) and always on Admin → Update. The banner can be hidden for
 * 7 days per admin (localStorage, best effort); then it comes back.
 */
import type { Locale } from '#lib/i18n';

const GUIDE = 'https://github.com/LetsManu/friendflix/blob/main/docs';
export const MOVE_GUIDE_EN = `${GUIDE}/plex.md#migrating-from-friendflix-plex-to-friendflix-20`;
export const MOVE_GUIDE_DE = `${GUIDE}/de/plex.md#umstieg-von-friendflix-plex-auf-friendflix-20`;
export const HIDE_MS = 7 * 24 * 3600 * 1000;

/** the migration guide in the viewer's language (German → German guide, everything else English) */
export const moveGuideUrl = (l: Locale | string): string => (l === 'de' ? MOVE_GUIDE_DE : MOVE_GUIDE_EN);

interface MeLike { isAdmin?: boolean; kids?: boolean; profile?: { isOwner?: boolean } | null }
/** role admin on the owner profile, never a normal user or a kids profile */
export const moveNoticeAudience = (me: MeLike | null | undefined): boolean => Boolean(me?.isAdmin && me.profile?.isOwner && !me.kids);

const keyOf = (uid: string): string => `ff-move-notice-hidden:${uid}`;

/** true while the notice is hidden (hidden-until timestamp in the future, and not further away than 7 days) */
export function moveHidden(uid: string, now = Date.now()): boolean {
  try {
    const v = Number(localStorage.getItem(keyOf(uid)));
    return Number.isFinite(v) && v > now && v <= now + HIDE_MS;
  } catch { return false; }
}

/** hides the notice for 7 days; storage that is blocked just means it stays visible */
export function hideMove(uid: string, now = Date.now()): void {
  try { localStorage.setItem(keyOf(uid), String(now + HIDE_MS)); } catch { /* stays visible */ }
}
