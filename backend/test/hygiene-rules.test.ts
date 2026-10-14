// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { CATEGORY, SEVERITY, compactFacts, itemIssues, keysOf, type IssueCode } from '../src/hygiene/rules.js';
import type { HygieneFacts, HygieneSource } from '../src/media/types.js';

// Block 22 Task 5: pure library hygiene rules (fixtures per code).
const DE = new Set(['deu']);
const src = (o: Partial<HygieneSource> = {}): HygieneSource => ({
  container: 'mkv', bitrate: 8_000_000, sizeBytes: 4e9, runtimeTicks: 6e10,
  video: [{ codec: 'h264', bitDepth: 8, height: 1080 }], audio: [{ codec: 'aac', lang: 'deu', channels: 2 }], subtitles: [], ...o,
});
const movie = (o: Partial<HygieneFacts> = {}): HygieneFacts => ({
  id: 'a'.repeat(32), type: 'Movie', name: 'Film', year: 2001, overview: true, poster: true, backdrop: true,
  providerIds: { tmdb: '603', imdb: 'tt0133093' }, runtimeTicks: 6e10, virtual: false, sources: [src()], ...o,
});
const series = (o: Partial<HygieneFacts> = {}): HygieneFacts => movie({ type: 'Series', sources: [], runtimeTicks: undefined, ...o });
const episode = (o: Partial<HygieneFacts> = {}): HygieneFacts =>
  movie({ type: 'Episode', seriesId: 'b'.repeat(32), seriesName: 'Serie', season: 1, episode: 2, overview: false, poster: false, backdrop: false, year: undefined, providerIds: {}, ...o });
const eng = { codec: 'aac', lang: 'eng', channels: 2 };

describe('hygiene rules: info', () => {
  it('a complete movie has no issue', () => {
    expect(itemIssues(movie(), DE)).toEqual([]);
  });

  it('movie without overview / poster / backdrop / year / ids → each code', () => {
    expect(itemIssues(movie({ overview: false }), DE)).toEqual(['no_overview']);
    expect(itemIssues(movie({ poster: false }), DE)).toEqual(['no_poster']);
    expect(itemIssues(movie({ backdrop: false }), DE)).toEqual(['no_backdrop']);
    expect(itemIssues(movie({ year: undefined }), DE)).toEqual(['no_year']);
    expect(itemIssues(movie({ providerIds: {} }), DE)).toEqual(['no_ids']);
    expect(itemIssues(movie({ providerIds: { tmdb: 'abc', imdb: 'nm123' } }), DE)).toEqual(['no_ids']);
    expect(itemIssues(movie({ providerIds: { tvdb: '1234' } }), DE)).toEqual(['no_ids']);
  });

  it('series likewise (no file or language checks for a series)', () => {
    expect(itemIssues(series(), DE)).toEqual([]);
    expect(itemIssues(series({ overview: false, poster: false, backdrop: false, year: undefined, providerIds: {} }), DE).sort())
      .toEqual(['no_backdrop', 'no_ids', 'no_overview', 'no_poster', 'no_year']);
  });

  it('episode → none of the info codes', () => {
    expect(itemIssues(episode(), DE)).toEqual([]);
  });
});

describe('hygiene rules: audio and subtitles', () => {
  it('no audio stream → no_audio; all audio und → audio_unknown', () => {
    expect(itemIssues(movie({ sources: [src({ audio: [] })] }), DE)).toEqual(['no_audio']);
    expect(itemIssues(movie({ sources: [src({ audio: [{ codec: 'aac', lang: 'und' }, { codec: 'ac3' }] })] }), DE)).toEqual(['audio_unknown']);
  });

  it('langs {deu}: subtitle rules', () => {
    const with_ = (subs: HygieneSource['subtitles']) => itemIssues(movie({ sources: [src({ audio: [eng], subtitles: subs })] }), DE).sort();
    expect(with_([{ codec: 'subrip', lang: 'ger', text: true, forced: false }])).toEqual([]);
    expect(with_([{ codec: 'subrip', lang: 'ger', text: true, forced: true }])).toEqual(['forced_only', 'foreign_no_subs']);
    expect(with_([{ codec: 'pgssub', lang: 'deu', text: false, forced: false }])).toEqual(['image_subs_only']);
    expect(with_([])).toEqual(['foreign_no_subs']);
    expect(with_([{ codec: 'subrip', lang: 'eng', text: true, forced: false }])).toEqual(['foreign_no_subs']);
    // German audio needs no subtitles
    expect(itemIssues(movie({ sources: [src({ audio: [eng, { codec: 'ac3', lang: 'ger' }] })] }), DE)).toEqual([]);
  });

  it('ger and deu are the same language (normLang)', () => {
    expect(itemIssues(movie({ sources: [src({ audio: [{ codec: 'aac', lang: 'ger' }] })] }), new Set(['deu']))).toEqual([]);
  });

  it('no household language known → no language issue', () => {
    expect(itemIssues(movie({ sources: [src({ audio: [eng] })] }), new Set())).toEqual([]);
  });

  it('language rules: an item is flagged only when every version has the problem', () => {
    expect(itemIssues(movie({ sources: [src({ audio: [eng] }), src()] }), DE)).toEqual([]);
    expect(itemIssues(movie({ sources: [src({ audio: [eng] }), src({ audio: [eng] })] }), DE)).toEqual(['foreign_no_subs']);
  });
});

describe('hygiene rules: files', () => {
  it('two versions, one 4K HEVC 10-bit and one 1080p h264 → no hevc_10bit; both HEVC 10-bit → hevc_10bit', () => {
    const uhd = src({ video: [{ codec: 'hevc', bitDepth: 10, height: 2160, hdr: true }] });
    expect(itemIssues(movie({ sources: [uhd, src()] }), DE)).toEqual([]);
    expect(itemIssues(movie({ sources: [uhd, uhd] }), DE)).toEqual(['hevc_10bit']);
    expect(itemIssues(movie({ sources: [src({ video: [{ codec: 'hevc', bitDepth: 8 }] })] }), DE)).toEqual([]);
  });

  it('bitrate 45 Mbit/s → heavy_bitrate; mpeg2 → video_codec; only DTS + TrueHD → audio_codec; DTS + AC3 → none', () => {
    expect(itemIssues(movie({ sources: [src({ bitrate: 45_000_000 })] }), DE)).toEqual(['heavy_bitrate']);
    expect(itemIssues(movie({ sources: [src({ bitrate: 40_000_000 })] }), DE)).toEqual([]);
    expect(itemIssues(movie({ sources: [src({ video: [{ codec: 'mpeg2video' }] })] }), DE)).toEqual(['video_codec']);
    expect(itemIssues(movie({ sources: [src({ video: [{ codec: 'vc1' }] })] }), DE)).toEqual(['video_codec']);
    expect(itemIssues(movie({ sources: [src({ video: [{ codec: 'av1' }] })] }), DE)).toEqual([]);
    expect(itemIssues(movie({ sources: [src({ audio: [{ codec: 'dts', lang: 'deu' }, { codec: 'truehd', lang: 'deu' }] })] }), DE)).toEqual(['audio_codec']);
    expect(itemIssues(movie({ sources: [src({ audio: [{ codec: 'dts', lang: 'deu' }, { codec: 'ac3', lang: 'deu' }] })] }), DE)).toEqual([]);
  });

  it('virtual or no source → no_source; runtime 0 → zero_runtime', () => {
    expect(itemIssues(movie({ virtual: true, sources: [] }), DE)).toEqual(['no_source']);
    expect(itemIssues(movie({ sources: [] }), DE)).toEqual(['no_source']);
    expect(itemIssues(movie({ sources: [src({ sizeBytes: 0 })] }), DE)).toEqual(['no_source']);
    expect(itemIssues(episode({ sources: [] }), DE)).toEqual(['no_source']);
    expect(itemIssues(movie({ runtimeTicks: 0, sources: [src({ runtimeTicks: 0 })] }), DE)).toEqual(['zero_runtime']);
    expect(itemIssues(movie({ runtimeTicks: undefined, sources: [src({ runtimeTicks: undefined })] }), DE)).toEqual(['zero_runtime']);
    expect(itemIssues(movie({ runtimeTicks: undefined, sources: [src()] }), DE)).toEqual([]);
  });

  it('an unprobed source (no streams at all) is not reported as no_audio', () => {
    expect(itemIssues(movie({ sources: [src({ video: [], audio: [], subtitles: [] })] }), DE)).toEqual([]);
  });

  it('every code has a category and a severity', () => {
    const codes: IssueCode[] = ['no_overview', 'no_poster', 'no_backdrop', 'no_year', 'no_ids', 'no_audio', 'audio_unknown', 'foreign_no_subs', 'forced_only',
      'image_subs_only', 'dup_ids', 'dup_title', 'dup_episode', 'no_source', 'zero_runtime', 'heavy_bitrate', 'hevc_10bit', 'video_codec', 'audio_codec'];
    expect(Object.keys(CATEGORY).sort()).toEqual([...codes].sort());
    expect(Object.keys(SEVERITY).sort()).toEqual([...codes].sort());
    expect(CATEGORY.foreign_no_subs).toBe('language');
    expect(SEVERITY.no_poster).toBe('warn');
    expect(SEVERITY.no_backdrop).toBe('info');
  });
});

describe('hygiene keys and compact facts', () => {
  it('keysOf: "Amélie" 2001 and "amelie" 2001 → same title key; invalid tmdb "12a" → ids from imdb; neither → null', () => {
    expect(keysOf(movie({ name: 'Amélie' })).title).toBe(keysOf(movie({ name: 'amelie!' })).title);
    expect(keysOf(movie({ name: 'Amélie' })).title).toBe('Movie:amelie:2001');
    expect(keysOf(movie({ year: undefined })).title).toBeNull();
    expect(keysOf(movie({ providerIds: { tmdb: '603' } })).ids).toBe('Movie:tmdb:603');
    expect(keysOf(movie({ providerIds: { tmdb: '12a', imdb: 'tt0133093' } })).ids).toBe('Movie:imdb:tt0133093');
    expect(keysOf(movie({ providerIds: { tmdb: '12a', imdb: 'x' } })).ids).toBeNull();
    expect(keysOf(series({ providerIds: { tmdb: '603' } })).ids).toBe('Series:tmdb:603');
    expect(keysOf(movie()).episode).toBeNull();
    const e = keysOf(episode());
    expect(e).toEqual({ ids: null, title: null, episode: `${'b'.repeat(32)}:1:2` });
    expect(keysOf(episode({ episode: undefined })).episode).toBeNull();
  });

  it('compactFacts keeps only what the rules and rows use (no name, no unknown keys such as a path)', () => {
    const f = movie({ sources: [{ ...src(), path: '/mnt/media/x.mkv' } as HygieneSource] });
    (f as unknown as Record<string, unknown>).path = '/mnt/media/x.mkv';
    const c = compactFacts(f);
    const json = JSON.stringify(c);
    expect(json).not.toContain('/mnt/media');
    expect(json).not.toContain('"name"');
    expect(json).toContain('"h264"');
  });
});
