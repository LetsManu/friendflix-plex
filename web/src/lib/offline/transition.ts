// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DownloadState } from './db';

export type PrepStatus = 'queued' | 'preparing' | 'ready' | 'failed';
export interface LocalTransition { state: DownloadState; prep?: number }

/** local state change implied by the server's prep status; null = leave the record alone */
export function nextLocalState(local: DownloadState, prep: { status: PrepStatus; percent: number }): LocalTransition | null {
  if (local !== 'queued' && local !== 'preparing') return null;
  const pc = Math.max(0, Math.min(100, Math.round(prep.percent)));
  if (prep.status === 'failed') return { state: 'error' };
  if (prep.status === 'preparing') return { state: 'preparing', prep: pc };
  if (prep.status === 'queued') return { state: 'queued', prep: 0 };
  return { state: 'queued', prep: undefined }; // ready: pump() starts it
}

/** whether pump() may start this record */
export const pumpable = (state: DownloadState, serverReady: boolean): boolean => state === 'queued' && serverReady;
