// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * 1.1 post-play screen ("caught up"): types of GET /api/items/:id/postplay, when the "Done? See what's next" card appears, the
 * headline per state and the anonymous counters (POST /api/postplay/event: fixed enums only, never a title).
 */
import { api, type Item } from '#lib/api';
import { markOrigin, recoReporter, type RecoEngine, type RecoKind, type RecoRow, type RecoTag } from '#lib/reco';
import type { TFn } from '#lib/i18n';

export type PostplayState = 'next' | 'movie_end' | 'series_finished' | 'caught_up' | 'gap';
export type RowKind = 'continuation' | 'transition' | 'universe' | 'because' | 'friends' | 'taste';
export interface RowReason { seed?: { id: string; name: string }; traits?: string[] }
export interface Wish { mediaType: 'tv'; tmdbId: number; quota: { limit: number | null; used: number; remaining: number | null; resetsAt: string } }
export interface PostplayRow {
  kind: RowKind; title: string; reason: RowReason; items: Item[]; wish?: Wish;
  /** which engine built the row, and the row kind the recommendation counters know it by (absent on older servers) */
  engine?: RecoEngine; recoRow?: RecoRow;
}
export interface Postplay {
  state: PostplayState;
  current: Item;
  next: Item | null;
  nextAirDate: string | null;
  sequel: Item | null;
  canWish: boolean;
  remind: { episodeId: string } | null;
  rows: PostplayRow[];
  hero: Item | null;
  suggestions: boolean;
  engine?: RecoEngine;
}

/** share of the runtime after which the card appears when neither an outro segment nor chapters say where the credits start */
export const END_SHARE = 0.95;
/** a last chapter only counts as the credits when it starts in the last 20 % (a long film's "final act" chapter is no credits) */
export const LAST_CHAPTER_SHARE = 0.8;

/**
 * Second from which the small "Done? See what's next" card shows: the outro segment, else the last chapter, else 95 % of the
 * runtime (Infinity while the duration is unknown).
 */
export function postplayStart(segments: Array<{ type: string; start: number }>, chapters: Array<{ start: number }>, duration: number): number {
  if (!(duration > 0)) return Infinity;
  const outro = segments.filter((s) => (s.type === 'outro' || s.type === 'credits') && s.start >= duration / 2 && s.start < duration).sort((a, b) => a.start - b.start)[0];
  if (outro) return outro.start;
  const last = [...chapters].filter((c) => c.start > 0 && c.start < duration).sort((a, b) => b.start - a.start)[0];
  if (last && last.start >= duration * LAST_CHAPTER_SHARE) return last.start;
  return duration * END_SHARE;
}

/**
 * The page shows the post-play card / overlay only when no next episode follows (the existing countdown handles that), the server
 * has the feature on, the profile did not switch it off and the title is not on a TV (the cast bar owns the end there).
 */
export const postplayWanted = (o: { type: string | undefined; hasNextEpisode: boolean; feature: boolean; pref: boolean; remote: boolean }): boolean =>
  o.feature && o.pref && !o.remote && !o.hasNextEpisode && (o.type === 'Movie' || o.type === 'Episode');

const label = (i: Item) => (i.type === 'Episode' && i.seriesName ? i.seriesName : i.name);

/** headline (top left) of the screen */
export function headline(p: Postplay, t: TFn): string {
  const title = label(p.current);
  switch (p.state) {
    case 'caught_up': return t('postplay.head.caughtUp');
    case 'series_finished': return t('postplay.head.seriesFinished', { title });
    case 'gap': return t('postplay.head.gap', { n: p.next?.indexNumber ?? '' });
    case 'next': {
      if (!p.next) return t('postplay.head.movieEnd', { title });
      const name = p.rows.find((r) => r.kind === 'continuation')?.title;
      return p.next.type === 'Episode' || !name ? t('postplay.head.nextEpisode', { title: p.next.name }) : t('postplay.head.nextPart', { name, title: p.next.name });
    }
    default: return t('postplay.head.movieEnd', { title });
  }
}

/** heading of one row, localized from its kind and subject */
export function rowTitle(r: PostplayRow, t: TFn): string {
  switch (r.kind) {
    case 'continuation': return t('postplay.row.continuation');
    case 'transition': return t('postplay.row.transition', { name: r.title });
    case 'universe': return t('postplay.row.universe', { name: r.title });
    case 'because': return t('postplay.row.because', { name: r.reason.seed?.name ?? r.title });
    case 'friends': return t('postplay.row.friends');
    default: return t('postplay.row.taste');
  }
}

/** short "why am I seeing this" line of a row (its reason) */
export function rowWhy(r: PostplayRow, t: TFn): string {
  if (r.kind === 'friends') return t('postplay.why.friends');
  return r.reason.seed && r.kind !== 'because' && r.kind !== 'continuation' ? t('postplay.why.seed', { name: r.reason.seed.name }) : '';
}

/** the row a title came from (telemetry label of a click / play) */
export function rowOf(p: Postplay, id: string): RowKind {
  return p.rows.find((r) => r.items.some((i) => i.id === id))?.kind ?? 'because';
}

export type PostplayEvent = { type: 'shown'; state: PostplayState } | { type: 'click' | 'play'; row: RowKind } | { type: 'dismiss' };
/** anonymous counter; failures are ignored (telemetry never gets in the way) */
export function track(e: PostplayEvent): void {
  api('/api/postplay/event', { method: 'POST', body: e, keepalive: true }).catch(() => undefined);
}

export const loadPostplay = (id: string, signal?: AbortSignal): Promise<Postplay> => api<Postplay>(`/api/items/${id}/postplay`, { signal });

/** The counter tag of a row (row kind + engine), or null for the continuation (the next part is not a recommendation) and unknown rows. */
export function recoTagOf(p: Postplay, kind: RowKind): RecoTag | null {
  const r = p.rows.find((x) => x.kind === kind);
  if (!r || r.kind === 'continuation') return null;
  return { row: r.recoRow ?? (r.kind === 'transition' ? 'transition' : r.kind === 'universe' ? 'universe' : r.kind === 'friends' ? 'friends' : r.kind === 'taste' ? 'top_picks' : 'postplay'), engine: r.engine ?? p.engine ?? 'v1' };
}

/** Counts one recommendation event (impression, click, play, dismiss) for a post-play row; the continuation is skipped. */
export function recoCount(p: Postplay, kind: RowKind, what: RecoKind, itemId?: string): void {
  const tag = recoTagOf(p, kind);
  if (!tag) return;
  recoReporter().add(tag, what);
  if (what === 'clicks' && itemId) markOrigin(tag, itemId); // the play that follows the click counts for this row
}
