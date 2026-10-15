// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Recommendation telemetry (spec 4.7): rows report how often they were shown and clicked, as counts per row and engine.
 * No item, title, position or profile is sent. Counts are batched and posted to /api/reco/events.
 * The batching is DOM-free so it can be unit tested; `recoReporter` binds it to the api helper.
 */
import { api } from '#lib/api';

export type RecoRow = 'because' | 'because_more' | 'top_picks' | 'popular' | 'friends' | 'postplay';
export type RecoEngine = 'v1' | 'v2';
export interface RecoTag { row: RecoRow; engine: RecoEngine }
export type RecoKind = 'impressions' | 'clicks' | 'dismisses';
export interface RecoEvent extends RecoTag { impressions: number; clicks: number; dismisses: number }

export const FLUSH_MS = 4000;
export const MAX_COUNT = 50; // server limit per event

export class RecoBatcher {
  private readonly acc = new Map<string, RecoEvent>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly post: (events: RecoEvent[]) => Promise<unknown>, private readonly flushMs = FLUSH_MS) {}

  add(tag: RecoTag, kind: RecoKind): void {
    const key = `${tag.row}|${tag.engine}`;
    const e = this.acc.get(key) ?? { row: tag.row, engine: tag.engine, impressions: 0, clicks: 0, dismisses: 0 };
    e[kind] = Math.min(MAX_COUNT, e[kind] + 1);
    this.acc.set(key, e);
    this.timer ??= setTimeout(() => void this.flush(), this.flushMs);
  }

  /** Sends what has been collected; a failure drops the counts (telemetry is never worth a retry loop). */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const events = [...this.acc.values()].slice(0, 12);
    this.acc.clear();
    if (!events.length) return;
    try { await this.post(events); } catch { /* ignore */ }
  }
}

let shared: RecoBatcher | undefined;
/** The page-wide batcher; flushed when the tab is hidden. */
export function recoReporter(): RecoBatcher {
  if (!shared) {
    const b = (shared = new RecoBatcher((events) => api('/api/reco/events', { method: 'POST', body: { events }, keepalive: true })));
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void b.flush(); });
  }
  return shared;
}

/**
 * Svelte action for a recommendation row: one impression the first time at least half of the row is on screen,
 * and one click for every link inside it that is followed. Listeners are attached here (not in the template) so the row stays a plain section.
 */
export function recoTrack(node: HTMLElement, tag: RecoTag | undefined) {
  let io: IntersectionObserver | undefined;
  let onClick: ((e: Event) => void) | undefined;
  if (tag) {
    if (typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) { recoReporter().add(tag, 'impressions'); io?.disconnect(); }
      }, { threshold: 0.5 });
      io.observe(node);
    }
    onClick = (e) => { if (isLinkClick(e)) recoReporter().add(tag, 'clicks'); };
    node.addEventListener('click', onClick);
  }
  return { destroy() { io?.disconnect(); if (onClick) node.removeEventListener('click', onClick); } };
}

/** True when the click landed on (or inside) a link. */
export function isLinkClick(e: Event): boolean {
  return Boolean((e.target as Element | null)?.closest?.('a[href]'));
}
