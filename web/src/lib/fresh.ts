/**
 * Block 17 D1: server-computed card badges (fresh label, "Nur noch N Tage"), facts of one title (quality chips, leaving date) and
 * the "Story so far" card. Cards ask for their badge by id; asks of one frame are sent as ONE request (POST /api/discover/badges) and
 * answers stay for five minutes. The server only answers for titles the viewer can see, so an unknown id simply has no badge.
 */
import { writable } from 'svelte/store';
import { api, getActiveProfile } from '#lib/api';

export type FreshLabel = 'newEpisode' | 'newSeason' | 'finale' | 'newSeries' | 'new';
export interface Badge { fresh?: FreshLabel; daysLeft?: number }
export interface MediaTraits { resolution: '4k' | 'hd' | 'sd'; hdr: 'dolbyvision' | 'hdr10plus' | 'hdr10' | 'hlg' | null; audio: 'atmos' | 'surround' | 'stereo' | 'mono' | null }
export interface Facts {
  fresh: FreshLabel | null;
  leaving: { leavesAt: string; days: number; note?: string } | null;
  traits: MediaTraits | null;
  /** the viewer may set / clear the removal date (admin on the owner profile) */
  admin?: boolean;
}

/** id -> badge ({} = answered, nothing to show; null = the request failed, cards fall back to the old client-side hints) */
export const badges = writable<Record<string, Badge | null>>({});

const TTL = 5 * 60_000;
const BATCH_MS = 40;
const BATCH_MAX = 80;
const seen = new Map<string, number>();
const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let owner = '';

function flush() {
  timer = undefined;
  const ids = [...pending].slice(0, BATCH_MAX);
  ids.forEach((i) => pending.delete(i));
  if (pending.size) timer = setTimeout(flush, BATCH_MS);
  if (!ids.length) return;
  const mine = owner;
  api<{ badges?: Record<string, Badge> }>('/api/discover/badges', { method: 'POST', body: { ids } }).then((r) => {
    if (mine !== getActiveProfile()) return; // profile switched meanwhile
    const got = r?.badges;
    badges.update((m) => {
      const next = { ...m };
      for (const id of ids) next[id] = got ? got[id] ?? {} : null;
      return next;
    });
  }).catch(() => {
    if (mine !== getActiveProfile()) return;
    badges.update((m) => { const next = { ...m }; for (const id of ids) if (!(id in next)) next[id] = null; return next; });
  });
}

/** Asks for the badge of a title (no-op while a fresh answer exists). Episodes: pass the series id. */
export function wantBadge(id: string | undefined, now = Date.now()): void {
  if (!id) return;
  const profile = getActiveProfile();
  if (profile !== owner) { owner = profile; seen.clear(); pending.clear(); badges.set({}); }
  const at = seen.get(id);
  if (at !== undefined && now - at < TTL) return;
  seen.set(id, now);
  pending.add(id);
  timer ??= setTimeout(flush, BATCH_MS);
}

// ---- facts of one title (detail view, hover pop-out) ----
const factsMemo = new Map<string, { at: number; p: Promise<Facts | null> }>();
export function loadFacts(id: string, now = Date.now()): Promise<Facts | null> {
  const hit = factsMemo.get(id);
  if (hit && now - hit.at < TTL) return hit.p;
  const p = api<Facts>(`/api/items/${id}/facts`).catch(() => null);
  factsMemo.set(id, { at: now, p });
  if (factsMemo.size > 200) factsMemo.delete(factsMemo.keys().next().value!);
  void p.then((f) => { if (!f) factsMemo.delete(id); });
  return p;
}
/** the removal date of a title changed (admin dialog): drop what was remembered */
export function forgetFacts(id: string): void {
  factsMemo.delete(id);
  seen.delete(id);
  badges.update((m) => { const next = { ...m }; delete next[id]; return next; });
  wantBadge(id);
}

// ---- "Story so far" ----
export interface Story {
  reason: 'newSeason' | 'longBreak';
  weeks?: number;
  season?: { number: number; name: string; overview: string };
  episode: { id: string; name: string; season: number; index: number; overview: string };
  next: { id: string; season: number; index: number };
}
