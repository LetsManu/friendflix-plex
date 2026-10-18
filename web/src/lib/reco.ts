// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Recommendation telemetry (spec 4.7): rows report how often they were shown and clicked, as counts per row and engine.
 * No item, title, position or profile is sent. Counts are batched and posted to /api/reco/events.
 * The batching is DOM-free so it can be unit tested; `recoReporter` binds it to the api helper.
 */
import { api } from '#lib/api';

/** the closed row set of the server (reco/rows.ts ROW_KINDS) */
export type RecoRow = 'continue' | 'because' | 'because_more' | 'top_picks' | 'popular' | 'friends' | 'postplay' | 'new' | 'leaving' | 'transition' | 'universe' | 'detail';
export type RecoEngine = 'v1' | 'v2';
export interface RecoTag { row: RecoRow; engine: RecoEngine }
export type RecoKind = 'impressions' | 'clicks' | 'plays' | 'dismisses';
export interface RecoEvent extends RecoTag { impressions: number; clicks: number; plays: number; dismisses: number }

export const FLUSH_MS = 4000;
export const MAX_COUNT = 50; // server limit per event

export class RecoBatcher {
  private readonly acc = new Map<string, RecoEvent>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly post: (events: RecoEvent[]) => Promise<unknown>, private readonly flushMs = FLUSH_MS) {}

  add(tag: RecoTag, kind: RecoKind): void {
    const key = `${tag.row}|${tag.engine}`;
    const e = this.acc.get(key) ?? { row: tag.row, engine: tag.engine, impressions: 0, clicks: 0, plays: 0, dismisses: 0 };
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
    onClick = (e) => { if (isLinkClick(e)) { recoReporter().add(tag, 'clicks'); rememberOrigin(tag, e); } };
    node.addEventListener('click', onClick);
  }
  return { destroy() { io?.disconnect(); if (onClick) node.removeEventListener('click', onClick); } };
}

// ---- plays: a playback that starts on a title opened from a recommendation row (the id stays in this tab's sessionStorage, never on the server)

const ORIGIN_KEY = 'ff.reco.origin';
/** a play counts for this long after the click */
export const ORIGIN_TTL_MS = 30 * 60_000;
interface Origin { row: RecoRow; engine: RecoEngine; ids: string[]; at: number }
const ID32 = /^[0-9a-f]{32}$/i;

/** The item id of a card link: /item/<id> or /watch/<id> (query and hash ignored), else null. */
export function itemIdOfHref(href: string | null | undefined): { id: string; play: boolean } | null {
  const m = /^\/(item|watch)\/([0-9a-f]{32})(?:[/?#]|$)/i.exec(href ?? '');
  return m && ID32.test(m[2]!) ? { id: m[2]!.toLowerCase(), play: m[1] === 'watch' } : null;
}

/** Remembers which recommendation row a followed link came from. A link straight to /watch/ is a play right away. */
export function rememberOrigin(tag: RecoTag, e: Event, store: Pick<Storage, 'setItem'> | null = safeStore()): void {
  const a = (e.target as Element | null)?.closest?.('a[href]');
  const hit = itemIdOfHref(a?.getAttribute?.('href'));
  if (!hit) return;
  if (hit.play) { recoReporter().add(tag, 'plays'); return; }
  markOrigin(tag, hit.id, store);
}

/** The next playback of this title (or of an episode of this series) within ORIGIN_TTL_MS counts as a play of the row. */
export function markOrigin(tag: RecoTag, id: string, store: Pick<Storage, 'setItem'> | null = safeStore()): void {
  try { store?.setItem(ORIGIN_KEY, JSON.stringify({ row: tag.row, engine: tag.engine, ids: [id], at: Date.now() } satisfies Origin)); } catch { /* storage blocked: no play is counted */ }
}

/**
 * Called when playback of a title starts (the watch page). If the viewer came to it (or to its series) from a recommendation row within
 * ORIGIN_TTL_MS, one play is counted for that row and engine and the mark is cleared.
 */
export function recoPlayStarted(ids: ReadonlyArray<string | undefined>, store: Pick<Storage, 'getItem' | 'removeItem'> | null = safeStore(), now = Date.now()): boolean {
  try {
    const raw = store?.getItem(ORIGIN_KEY);
    if (!raw) return false;
    const o = JSON.parse(raw) as Origin;
    if (!(now - o.at <= ORIGIN_TTL_MS) || !o.ids.some((id) => ids.includes(id))) return false;
    store!.removeItem(ORIGIN_KEY);
    recoReporter().add({ row: o.row, engine: o.engine }, 'plays');
    return true;
  } catch {
    return false;
  }
}

function safeStore(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

/** True when the click landed on (or inside) a link. */
export function isLinkClick(e: Event): boolean {
  return Boolean((e.target as Element | null)?.closest?.('a[href]'));
}
