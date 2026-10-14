// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Admin → Bibliothekspflege (Block 22): mirror of `backend/src/routes/hygiene.ts` and the pure helpers of the page. */
import type { TKey } from '#lib/i18n';

export const CATEGORIES = ['info', 'language', 'duplicate', 'file'] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY = {
  no_overview: 'info', no_poster: 'info', no_backdrop: 'info', no_year: 'info', no_ids: 'info',
  no_audio: 'language', audio_unknown: 'language', foreign_no_subs: 'language', forced_only: 'language', image_subs_only: 'language',
  dup_ids: 'duplicate', dup_title: 'duplicate', dup_episode: 'duplicate',
  no_source: 'file', zero_runtime: 'file', heavy_bitrate: 'file', hevc_10bit: 'file', video_codec: 'file', audio_codec: 'file',
} as const satisfies Record<string, Category>;
export type IssueCode = keyof typeof CATEGORY;
export const ISSUE_CODES = Object.keys(CATEGORY) as IssueCode[];
export type Severity = 'warn' | 'info';
export type ItemType = 'Movie' | 'Series' | 'Episode';

export interface HygieneSummary {
  state: { supported: boolean; running: boolean; lastDone: string | null; lastFull: string | null };
  total: number; byCategory: Record<Category, number>; byIssue: Partial<Record<IssueCode, number>>; ignored: number; canRefresh: boolean;
}
export interface HygieneRow {
  itemId: string; type: ItemType; name: string; seriesId: string | null; seriesName: string | null; year: number | null;
  issues: Array<{ code: IssueCode; severity: Severity }>; versions: number; container: string | null; bitrate: number | null; sizeBytes: number | null;
  video: string | null; audio: string[]; subtitles: string[]; dupOf: string[];
}
export type HygieneSort = 'name' | 'issues' | 'size' | 'bitrate';
export interface HygieneFilter {
  category?: Category | ''; issue?: IssueCode | ''; type?: ItemType | ''; seriesId?: string;
  q: string; sort: HygieneSort; dir?: 'asc' | 'desc'; offset: number; limit: number;
}

/** list query; empty filters are left out (the server treats a missing filter as "all") */
export function hygieneQuery(f: HygieneFilter): URLSearchParams {
  const p = new URLSearchParams();
  const put = (k: string, v: string | number | undefined | null) => { const s = v === undefined || v === null ? '' : String(v).trim(); if (s) p.set(k, s); };
  put('category', f.category); put('issue', f.issue); put('type', f.type); put('seriesId', f.seriesId); put('q', f.q);
  put('sort', f.sort); put('dir', f.dir);
  p.set('offset', String(f.offset)); p.set('limit', String(f.limit));
  return p;
}

export const categoryOf = (c: IssueCode): Category => CATEGORY[c];
export const codesOf = (cat: Category | '' | null): IssueCode[] => (cat ? ISSUE_CODES.filter((c) => CATEGORY[c] === cat) : [...ISSUE_CODES]);
export const issueLabel = (c: IssueCode): TKey => `adminContent.hygiene.issues.${c}` as TKey;
export const issueHint = (c: IssueCode): TKey => `adminContent.hygiene.hints.${c}` as TKey;
/** episodes read "Serie · Folge" (the row carries no season/episode numbers) */
export const rowTitle = (r: Pick<HygieneRow, 'type' | 'name' | 'seriesName'>): string => (r.type === 'Episode' && r.seriesName ? `${r.seriesName} · ${r.name}` : r.name);
