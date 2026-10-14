// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** /api/admin/summary as a shared store: the shell shows its badges, the overview its tiles; pages refresh it after actions. */
import { writable, type Readable } from 'svelte/store';
import { api } from '#lib/api';

export interface AdminSummary {
  users: { total: number; active: number; locked: number };
  pending: { requests: number | null; devices: number; polls: number; invites: number; previewsFailed: number };
  requests: { pending: number; approved: number; processing: number; available: number; declined: number; total: number } | null;
  storage: { downloadsEnabled: boolean; downloadsBytes: number; downloadsMaxBytes: number; previewBytes: number; previewClips: number };
  playbackCheck: { finishedAt: string; total: number; failed: number } | null;
  services: { jellyfin: boolean; seerr: boolean };
  live: { streams: number; partyRooms: number };
}

const store = writable<AdminSummary | null>(null);
const errStore = writable(false);
export const summary: Readable<AdminSummary | null> = { subscribe: store.subscribe };
/** true when the last load failed (the overview shows an error with retry) */
export const summaryFailed: Readable<boolean> = { subscribe: errStore.subscribe };

let inflight: Promise<void> | null = null;
/** (Re)loads the summary; parallel calls share one request. */
export function refreshSummary(): Promise<void> {
  inflight ??= api<AdminSummary>('/api/admin/summary')
    .then((s) => { store.set(s); errStore.set(false); }, () => errStore.set(true))
    .finally(() => { inflight = null; });
  return inflight;
}
/** Adjusts a pending count locally (optimistic badge after approve/decline); the next refresh corrects it. */
export function bumpPending(key: keyof AdminSummary['pending'], delta: number): void {
  store.update((s) => {
    if (!s) return s;
    const v = s.pending[key];
    return v === null ? s : { ...s, pending: { ...s.pending, [key]: Math.max(0, v + delta) } };
  });
}
/** test helper */
export const setSummary = (s: AdminSummary | null): void => store.set(s);
