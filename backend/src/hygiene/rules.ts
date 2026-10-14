// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { normLang } from '../langindex.js';
import type { HygieneFacts, HygieneSource, HygieneStream, ProviderIds } from '../media/types.js';

/**
 * Block 22: library hygiene rules. Pure functions over neutral HygieneFacts (no I/O); duplicates are not decided here
 * (they need the whole library and are recomputed in SQL by hygiene/scan.ts from the keys of keysOf()).
 */
export type IssueCode =
  | 'no_overview' | 'no_poster' | 'no_backdrop' | 'no_year' | 'no_ids'
  | 'no_audio' | 'audio_unknown' | 'foreign_no_subs' | 'forced_only' | 'image_subs_only'
  | 'dup_ids' | 'dup_title' | 'dup_episode'
  | 'no_source' | 'zero_runtime' | 'heavy_bitrate' | 'hevc_10bit' | 'video_codec' | 'audio_codec';
export type Category = 'info' | 'language' | 'duplicate' | 'file';

export const CATEGORY: Record<IssueCode, Category> = {
  no_overview: 'info', no_poster: 'info', no_backdrop: 'info', no_year: 'info', no_ids: 'info',
  no_audio: 'language', audio_unknown: 'language', foreign_no_subs: 'language', forced_only: 'language', image_subs_only: 'language',
  dup_ids: 'duplicate', dup_title: 'duplicate', dup_episode: 'duplicate',
  no_source: 'file', zero_runtime: 'file', heavy_bitrate: 'file', hevc_10bit: 'file', video_codec: 'file', audio_codec: 'file',
};
export const SEVERITY: Record<IssueCode, 'warn' | 'info'> = {
  no_overview: 'warn', no_poster: 'warn', no_backdrop: 'info', no_year: 'info', no_ids: 'info',
  no_audio: 'warn', audio_unknown: 'info', foreign_no_subs: 'warn', forced_only: 'info', image_subs_only: 'info',
  dup_ids: 'warn', dup_title: 'info', dup_episode: 'warn',
  no_source: 'warn', zero_runtime: 'warn', heavy_bitrate: 'info', hevc_10bit: 'info', video_codec: 'warn', audio_codec: 'info',
};
export const ISSUE_CODES = Object.keys(CATEGORY) as IssueCode[];
export const DUP_CODES: readonly IssueCode[] = ['dup_ids', 'dup_title', 'dup_episode'];
/** codes that depend on the household languages (recomputed from stored facts when that set changes) */
export const LANGUAGE_CODES: readonly IssueCode[] = ['no_audio', 'audio_unknown', 'foreign_no_subs', 'forced_only', 'image_subs_only'];

/** above this source bitrate most roles transcode outside the home network */
export const HEAVY_BPS = 40_000_000;
export const OK_VIDEO = ['h264', 'hevc', 'vp9', 'av1'];
export const OK_AUDIO = ['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac'];
const VIDEO_ALIAS: Record<string, string> = { avc: 'h264', avc1: 'h264', h265: 'hevc', hvc1: 'hevc', hev1: 'hevc', vp09: 'vp9', av01: 'av1' };

const TMDB_RE = /^\d{1,9}$/;
const IMDB_RE = /^tt\d{7,10}$/;
const validTmdb = (p: ProviderIds) => (p.tmdb && TMDB_RE.test(p.tmdb) ? p.tmdb : null);
const validImdb = (p: ProviderIds) => (p.imdb && IMDB_RE.test(p.imdb) ? p.imdb : null);

const videoCodec = (s: HygieneStream | undefined) => {
  const c = s?.codec?.toLowerCase();
  return c ? VIDEO_ALIAS[c] ?? c : undefined;
};
const positive = (n: number | undefined) => typeof n === 'number' && n > 0;

/** A source without any probed stream (no video, audio or subtitle) is "unknown", not "silent". */
const probed = (s: HygieneSource) => s.video.length + s.audio.length + s.subtitles.length > 0;

function sourceLanguage(s: HygieneSource, langs: ReadonlySet<string>): Set<IssueCode> {
  const out = new Set<IssueCode>();
  if (!probed(s)) return out;
  if (s.video.length && !s.audio.length) { out.add('no_audio'); return out; }
  if (!s.audio.length) return out;
  const audio = s.audio.map((a) => normLang(a.lang));
  if (audio.every((l) => l === null)) { out.add('audio_unknown'); return out; }
  if (!langs.size || audio.some((l) => l !== null && langs.has(l))) return out;
  // the audio is in a foreign language: look at the household-language subtitles
  const subs = s.subtitles.filter((x) => { const l = normLang(x.lang); return l !== null && langs.has(l); });
  const full = subs.filter((x) => !x.forced);
  if (!full.length) out.add('foreign_no_subs');
  if (subs.length && !full.length) out.add('forced_only');
  if (full.length && full.every((x) => !x.text)) out.add('image_subs_only');
  return out;
}

function sourceFile(s: HygieneSource, itemRuntime: number | undefined): Set<IssueCode> {
  const out = new Set<IssueCode>();
  if (!positive(s.runtimeTicks ?? itemRuntime)) out.add('zero_runtime');
  if (typeof s.bitrate === 'number' && s.bitrate > HEAVY_BPS) out.add('heavy_bitrate');
  const v = s.video[0];
  const vc = videoCodec(v);
  if (vc === 'hevc' && (v?.bitDepth ?? 0) >= 10) out.add('hevc_10bit');
  if (vc && !OK_VIDEO.includes(vc)) out.add('video_codec');
  if (s.audio.length && s.audio.every((a) => a.codec && !OK_AUDIO.includes(a.codec.toLowerCase()))) out.add('audio_codec');
  return out;
}

/** Codes present in every one of the sets (an item with several versions is flagged only when every version has the problem). */
function everyOf(sets: Array<Set<IssueCode>>): IssueCode[] {
  const [first, ...rest] = sets;
  if (!first) return [];
  return [...first].filter((c) => rest.every((s) => s.has(c)));
}

/**
 * Issues of one item (no duplicate codes; those come from SQL). Info checks for films and series only, file and language checks for
 * films and episodes only. `langs` are normalised (normLang) household languages; an empty set disables the subtitle rules.
 */
export function itemIssues(f: HygieneFacts, langs: ReadonlySet<string>): IssueCode[] {
  const out: IssueCode[] = [];
  if (f.type === 'Movie' || f.type === 'Series') {
    if (!f.overview) out.push('no_overview');
    if (!f.poster) out.push('no_poster');
    if (!f.backdrop) out.push('no_backdrop');
    if (!positive(f.year)) out.push('no_year');
    if (!validTmdb(f.providerIds) && !validImdb(f.providerIds)) out.push('no_ids');
  }
  if (f.type === 'Series') return out;
  const sources = f.sources.filter((s) => s.sizeBytes !== 0);
  if (f.virtual || !sources.length) {
    out.push('no_source');
    return out;
  }
  out.push(...everyOf(sources.map((s) => sourceLanguage(s, langs))));
  out.push(...everyOf(sources.map((s) => sourceFile(s, f.runtimeTicks))));
  return out;
}

/** "Amélie" → "amelie": NFKD, diacritics and everything but letters / digits removed, lower case. */
export function normTitle(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Duplicate keys: same provider id (films / series), same normalised title + year (films / series), same series episode. */
export function keysOf(f: HygieneFacts): { ids: string | null; title: string | null; episode: string | null } {
  let ids: string | null = null;
  let title: string | null = null;
  let episode: string | null = null;
  if (f.type === 'Movie' || f.type === 'Series') {
    const tmdb = validTmdb(f.providerIds), imdb = validImdb(f.providerIds);
    ids = tmdb ? `${f.type}:tmdb:${tmdb}` : imdb ? `${f.type}:imdb:${imdb}` : null;
    const t = normTitle(f.name);
    title = t && positive(f.year) ? `${f.type}:${t}:${f.year}` : null;
  } else if (f.seriesId && Number.isInteger(f.season) && Number.isInteger(f.episode)) {
    episode = `${f.seriesId}:${f.season}:${f.episode}`;
  }
  return { ids, title, episode };
}

/** What hygiene_items.facts stores: only fields the rules and the admin rows use (whitelisted, so nothing else ever lands there). */
export interface StoredFacts {
  overview: boolean; poster: boolean; backdrop: boolean; providerIds: ProviderIds; virtual: boolean;
  season?: number; episode?: number; runtimeTicks?: number;
  sources: HygieneSource[];
}

const pick = <T extends object, K extends keyof T>(o: T, keys: readonly K[]): Partial<Pick<T, K>> => {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  return out;
};
const VIDEO_KEYS = ['codec', 'bitDepth', 'height', 'hdr'] as const;
const AUDIO_KEYS = ['codec', 'lang', 'channels'] as const;
const SUB_KEYS = ['codec', 'lang', 'forced', 'text'] as const;
const SOURCE_KEYS = ['container', 'bitrate', 'sizeBytes', 'runtimeTicks'] as const;

export function compactFacts(f: HygieneFacts): StoredFacts {
  return {
    overview: f.overview, poster: f.poster, backdrop: f.backdrop, virtual: f.virtual,
    providerIds: pick(f.providerIds ?? {}, ['imdb', 'tmdb', 'tvdb'] as const),
    ...pick(f, ['season', 'episode', 'runtimeTicks'] as const),
    sources: (f.sources ?? []).map((s) => ({
      ...pick(s, SOURCE_KEYS),
      video: (s.video ?? []).slice(0, 2).map((x) => pick(x, VIDEO_KEYS)),
      audio: (s.audio ?? []).slice(0, 30).map((x) => pick(x, AUDIO_KEYS)),
      subtitles: (s.subtitles ?? []).slice(0, 60).map((x) => pick(x, SUB_KEYS)),
    })),
  };
}

/** Rebuilds the facts the rules need from a stored row (language recompute without asking the media server). */
export function factsFromRow(r: { item_id: string; type: HygieneFacts['type']; name: string; series_id: string | null; year: number | null; facts: StoredFacts }): HygieneFacts {
  return {
    ...r.facts, id: r.item_id, type: r.type, name: r.name,
    seriesId: r.series_id ?? undefined, year: r.year ?? undefined,
    providerIds: r.facts.providerIds ?? {}, sources: r.facts.sources ?? [],
  };
}
