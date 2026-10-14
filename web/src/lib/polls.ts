// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { tr } from './i18n';

export const POLL_MS = 15_000;
export const POLL_MAX_FAILURES = 5;

/** Delay before the next background refresh; backs off exponentially after failures and gives up (null) after too many. */
export function pollDelay(failures: number): number | null {
  if (failures >= POLL_MAX_FAILURES) return null;
  return failures <= 0 ? POLL_MS : Math.min(POLL_MS * 2 ** failures, 120_000);
}

export function voteError(e: unknown): string {
  const x = e as { status?: number; body?: { error?: string } } | null;
  if (x?.status === 409 && x.body?.error === 'poll_closed_or_option_invalid') return tr('social.vote.closed');
  return tr('social.vote.voteFailed');
}
