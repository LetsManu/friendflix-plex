// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Re-authentication for sensitive account actions (backend reauth.ts): such an action answers 401 `reauth_required`
 * (api() does not treat it as a lost session), the page sends the person through a forced sign-in and back to `next`.
 * A sign-in as somebody else comes back as `/me/account?reauth=failed`.
 */
import { ApiError } from '#lib/api';

/** /auth/reauth URL that returns to `next` (a same-site path; the backend falls back to /me/account for anything else) */
export const reauthHref = (next: string): string => '/auth/reauth?next=' + encodeURIComponent(next);

export function startReauth(next: string): void {
  location.href = reauthHref(next);
}

/** true for the 401 `reauth_required` answer of an action that needs a recent sign-in */
export const isReauthError = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 401 && (e.body as { error?: unknown } | null)?.error === 'reauth_required';
