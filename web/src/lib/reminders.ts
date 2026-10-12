import { writable, get } from 'svelte/store';
import { api, ApiError } from '#lib/api';

/** 'movie:603' | 'tv:1396' | 'ep:<jellyfin id>' -> reminder id */
export const remindKeys = writable<Record<string, number>>({});
let loaded: Promise<void> | null = null;
const pending = new Set<string>();

export const movieKey = (mediaType: string, tmdbId: number) => `${mediaType}:${tmdbId}`;
export const episodeKey = (id: string) => `ep:${id}`;

export function loadReminders(force = false): Promise<void> {
  if (!loaded || force) loaded = api('/api/reminders/keys').then((r) => remindKeys.set(r.keys ?? {})).catch(() => { loaded = null; });
  return loaded;
}

export type ToggleResult = 'on' | 'off' | 'available' | 'busy' | 'error';

/** Optimistic toggle; rolls back on failure. 409 already_available -> 'available'. */
export async function toggleReminder(key: string, body: { mediaType: string; tmdbId: number } | { episodeId: string }): Promise<ToggleResult> {
  if (pending.has(key)) return 'busy';
  pending.add(key);
  try { return await doToggle(key, body); } finally { pending.delete(key); }
}

async function doToggle(key: string, body: { mediaType: string; tmdbId: number } | { episodeId: string }): Promise<ToggleResult> {
  const before = get(remindKeys);
  const existing = before[key];
  if (existing !== undefined) {
    const { [key]: _gone, ...rest } = before;
    remindKeys.set(rest);
    try { await api(`/api/reminders/${existing}`, { method: 'DELETE' }); return 'off'; }
    catch (e) { if (e instanceof ApiError && e.status === 404) return 'off'; remindKeys.set(before); return 'error'; }
  }
  remindKeys.set({ ...before, [key]: 0 });
  try {
    const r = await api('/api/reminders', { method: 'POST', body });
    remindKeys.update((k) => ({ ...k, [key]: r.id }));
    return 'on';
  } catch (e) {
    remindKeys.set(before);
    return e instanceof ApiError && e.status === 409 ? 'available' : 'error';
  }
}

export async function removeReminder(key: string, id: number) {
  await api(`/api/reminders/${id}`, { method: 'DELETE' });
  remindKeys.update(({ [key]: _gone, ...rest }) => rest);
}
