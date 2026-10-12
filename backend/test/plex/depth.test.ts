/**
 * Block 17 parity on Plex (fork): chapters (real PMS 1.43 chapter answer, fixture movie_chapters_detail), quality traits from the
 * mirrored streams, credits from the mirrored tags, library-wide continuing series - all against the Plex fake.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publicCapabilities, type MediaUser } from '../../src/media/types.js';
import { bestTraits, chapterDtos, mediaVersionTraits, plexTraits } from '../../src/plex/depth.js';
import { verifyChSig } from '../../src/plex/mediapaths.js';
import { chaptersOf } from '../../src/plex/mirror.js';
import { fixture, PLEX_TEST_SECRET, PLEX_TOKEN } from '../plexfake.js';
import { identity, item, kids, plexEnv, tag, type PlexEnv } from './setup.js';

const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

describe('Plex depth mappers (pure)', () => {
  it('chaptersOf: the real PMS answer (names, ms offsets, chapter image media id + index)', () => {
    const m = fixture('movie_chapters_detail').MediaContainer.Metadata[0];
    expect(chaptersOf(m)).toEqual([
      { start: 0, name: 'Opening', media: '11', index: 1 },
      { start: 20000, name: 'The Heist', media: '11', index: 2 },
      { start: 40000, name: 'Chapter 3', media: '11', index: 3 },
    ]);
    expect(chaptersOf({})).toBeNull();
    // foreign / absolute thumbs are never kept, broken offsets dropped
    expect(chaptersOf({ Chapter: [{ tag: 'x', startTimeOffset: 5, thumb: 'http://evil/library/media/1/chapterImages/1' }, { tag: 'y', startTimeOffset: -1 }, { startTimeOffset: 'a' }] }))
      .toEqual([{ start: 5, name: 'x' }]);
  });

  it('chapterDtos: seconds, generic names blank, sorted, one per start, signed stills only with a secret', () => {
    const raw = [{ start: 40000, name: 'Chapter 3', media: '11', index: 3 }, { start: 0, name: 'Opening', media: '11', index: 1 }, { start: 0, name: 'dup' }, { start: 12345, name: 'Kapitel 2' }];
    const id = item(15);
    const out = chapterDtos(id, raw, 's'.repeat(32));
    expect(out.map((c) => [c.start, c.name])).toEqual([[0, 'Opening'], [12.3, ''], [40, '']]);
    const img = new URL(out[0]!.image!, 'http://x');
    expect(img.pathname).toBe(`/media/Items/${id}/Images/Chapter/1`);
    expect(verifyChSig('s'.repeat(32), id, img.searchParams.get('media')!, img.searchParams.get('sig')!)).toBe(true);
    expect(out[1]!.image).toBeUndefined();
    expect(chapterDtos(id, raw).every((c) => c.image === undefined)).toBe(true);
    expect(chapterDtos(id, null)).toEqual([]);
  });

  it('traits: resolution by size (cropped 4K too), Dolby Vision / HDR10 / HDR10+ / HLG, audio layout incl. Atmos', () => {
    const v = (video: Record<string, unknown>, audio: Array<Record<string, unknown>> = [], md: Record<string, unknown> = {}) =>
      mediaVersionTraits({ ...md, Part: [{ Stream: [{ streamType: 1, ...video }, ...audio.map((a) => ({ streamType: 2, ...a }))] }] });
    // the real fixtures: SD (640x360) h264 + mono AAC, HEVC SD + mono
    expect(plexTraits(fixture('movie1_detail').MediaContainer.Metadata[0].Media)).toEqual({ resolution: 'sd', hdr: null, audio: 'mono' });
    expect(plexTraits(fixture('movie2_hevc_detail').MediaContainer.Metadata[0].Media)).toEqual({ resolution: 'sd', hdr: null, audio: 'mono' });
    expect(v({ width: 3840, height: 1600, DOVIPresent: true, colorTrc: 'smpte2084' }, [{ channels: 8, displayTitle: 'English (TrueHD 7.1 Atmos)' }]))
      .toEqual({ resolution: '4k', hdr: 'dolbyvision', audio: 'atmos' });
    expect(v({ width: 3840, height: 2160, colorTrc: 'smpte2084' }, [{ channels: 6 }])).toEqual({ resolution: '4k', hdr: 'hdr10', audio: 'surround' });
    expect(v({ width: 3840, height: 2160, displayTitle: '4K HDR10+ (HEVC Main 10)' })).toMatchObject({ hdr: 'hdr10plus', audio: null });
    expect(v({ width: 1920, height: 1080, colorTrc: 'arib-std-b67' }, [{ channels: 2 }])).toEqual({ resolution: 'hd', hdr: 'hlg', audio: 'stereo' });
    expect(v({ width: 1280, height: 534, colorTrc: 'bt709' }, [{ channels: 2 }, { channels: 6 }])).toEqual({ resolution: 'hd', hdr: null, audio: 'surround' });
    // no stream details (listing form): Media-level fields
    expect(mediaVersionTraits({ videoResolution: '4k', audioChannels: 6, Part: [{}] })).toEqual({ resolution: '4k', hdr: null, audio: 'surround' });
    expect(mediaVersionTraits({ Part: [{ Stream: [{ streamType: 2, channels: 2 }] }] })).toBeNull();
    // best of several versions, each axis on its own
    expect(bestTraits({ resolution: '4k', hdr: null, audio: 'stereo' }, { resolution: 'hd', hdr: 'hdr10', audio: 'atmos' })).toEqual({ resolution: '4k', hdr: 'hdr10', audio: 'atmos' });
    expect(bestTraits({ resolution: 'hd', hdr: 'hdr10', audio: null }, { resolution: 'hd', hdr: 'dolbyvision', audio: null })!.hdr).toBe('dolbyvision');
  });
});

describe('Plex depth over the mirror (chapters, traits, credits, continuing series)', () => {
  let e: PlexEnv;
  let admin: MediaUser;
  let child: MediaUser;
  const lib: Record<string, string> = {};
  const outputs: unknown[] = [];
  const keep = <T>(v: T): T => (outputs.push(v), v);

  beforeAll(async () => {
    e = await plexEnv((f) => {
      lib.chap = f.addChapterMovie();
      lib.uhd = f.addMovie({
        title: 'Ultra Film', rating: 'PG', studio: 'Big Studio', labels: ['Heist'],
        actors: [{ id: 601, tag: 'Ann Actor', role: 'Thief' }, { id: 602, tag: 'Bob Actor' }],
        directors: [{ id: 603, tag: 'Dee Director' }], writers: [{ id: 604, tag: 'Wes Writer' }, { id: 603, tag: 'Dee Director' }],
      });
      f.setStreams(lib.uhd!, { width: 3840, height: 2160, DOVIPresent: true, DOVIProfile: 8, colorTrc: 'smpte2084', displayTitle: '4K DoVi/HDR10 (HEVC Main 10)' },
        [{ channels: 8, displayTitle: 'English (TrueHD 7.1 Atmos)', audioChannelLayout: '7.1' }]);
      const recent = f.addShow({ title: 'Airing Now', rating: 'TV-PG', episodeRating: 'TV-PG', episodes: 2, aired: days(5) });
      lib.recent = recent.show;
      f.setStreams(recent.episodes[1]!, { width: 1920, height: 1080, colorTrc: 'smpte2084' }, [{ channels: 6 }]);
      lib.ended = f.addShow({ title: 'Long Over', rating: 'TV-PG', episodeRating: 'TV-PG', episodes: 2, aired: days(400) }).show;
      lib.adult = f.addMovie({ title: 'Adult Film', rating: 'R', actors: [{ id: 605, tag: 'Hidden Person', role: 'X' }] });
    });
    admin = await identity(e.ms, 'admin');
    child = await identity(e.ms, 'friend', kids(12));
  });
  afterAll(async () => {
    expect(JSON.stringify(outputs)).not.toContain(PLEX_TOKEN);
    await e.close();
  });

  it('the detail sync mirrors chapters; capability chapters follows the mirror', async () => {
    expect(e.fake.calls.some((c) => c.path.startsWith('/library/metadata/') && c.search.includes('includeChapters=1'))).toBe(true);
    expect(e.ms.capabilities.chapters).toBe(true);
    expect(publicCapabilities(e.ms.capabilities).chapters).toBe(true);
  });

  it('chapters: real chapter marks with signed stills; none for a file without chapters; 404 when not visible', async () => {
    const ch = keep(await e.ms.chapters(admin, item(lib.chap!)));
    expect(ch.map((c) => [c.start, c.name])).toEqual([[0, 'Opening'], [20, 'The Heist'], [40, '']]);
    for (const [i, c] of ch.entries()) {
      const u = new URL(c.image!, 'http://x');
      expect(u.pathname).toBe(`/media/Items/${item(lib.chap!)}/Images/Chapter/${i + 1}`);
      expect(u.searchParams.get('media')).toBe('11');
      expect(verifyChSig(PLEX_TEST_SECRET, item(lib.chap!), '11', u.searchParams.get('sig')!)).toBe(true);
    }
    expect(await e.ms.chapters(admin, item(1))).toEqual([]);
    await expect(e.ms.chapters(child, item(lib.adult!))).rejects.toMatchObject({ status: 404 });
    await expect(e.ms.chapters(admin, item(99999))).rejects.toMatchObject({ status: 404 });
  });

  it('mediaTraits: movie from its streams, series = best visible episode, hidden -> null', async () => {
    expect(keep(await e.ms.mediaTraits(admin, item(lib.uhd!)))).toEqual({ resolution: '4k', hdr: 'dolbyvision', audio: 'atmos' });
    expect(await e.ms.mediaTraits(admin, item(1))).toEqual({ resolution: 'sd', hdr: null, audio: 'mono' });
    expect(await e.ms.mediaTraits(admin, item(lib.recent!))).toEqual({ resolution: 'hd', hdr: 'hdr10', audio: 'surround' });
    expect(await e.ms.mediaTraits(child, item(lib.adult!))).toBeNull();
    expect(await e.ms.mediaTraits(admin, item(99999))).toBeNull();
  });

  it('libraryMediaTraits: every movie / episode, stable pages, seriesId on episodes, a short page ends', async () => {
    const all = await e.ms.libraryMediaTraits('Movie', 0, 100);
    expect(all.map((x) => x.id)).toContain(item(lib.adult!)); // admin-level: library-wide, independent of any viewer
    expect(all.find((x) => x.id === item(lib.uhd!))!.traits).toEqual({ resolution: '4k', hdr: 'dolbyvision', audio: 'atmos' });
    const p1 = await e.ms.libraryMediaTraits('Movie', 0, 2);
    const p2 = await e.ms.libraryMediaTraits('Movie', 2, 2);
    expect(p1.length).toBe(2);
    expect([...p1, ...p2].map((x) => x.id)).toEqual(all.slice(0, 4).map((x) => x.id));
    const eps = await e.ms.libraryMediaTraits('Episode', 0, 1000);
    expect(eps.every((x) => x.seriesId)).toBe(true);
    expect(eps.filter((x) => x.seriesId === item(lib.recent!)).map((x) => x.traits.resolution).sort()).toEqual(['hd', 'sd']);
  });

  it('libraryContinuingSeriesIds: only series whose every episode aired long ago count as ended', async () => {
    const ids = await e.ms.libraryContinuingSeriesIds(0, 500);
    expect(ids).toContain(item(lib.recent!));
    expect(ids).toContain(item(3)); // the fixture show: episodes without air dates -> unknown -> continuing (never a wrong finale)
    expect(ids).not.toContain(item(lib.ended!));
    expect(await e.ms.libraryContinuingSeriesIds(0, 1)).toHaveLength(1);
    expect(await e.ms.libraryContinuingSeriesIds(500, 10)).toEqual([]);
  });

  it('credits: actors with character names, director, writer (a person may hold both), studio, labels; 404 when hidden', async () => {
    const c = keep(await e.ms.credits(admin, item(lib.uhd!)));
    expect(c.people).toEqual([
      { id: tag(601), name: 'Ann Actor', role: 'Thief', type: 'Actor', image: false },
      { id: tag(602), name: 'Bob Actor', type: 'Actor', image: false },
      { id: tag(603), name: 'Dee Director', type: 'Director', image: false },
      { id: tag(604), name: 'Wes Writer', type: 'Writer', image: false },
      { id: tag(603), name: 'Dee Director', type: 'Writer', image: false },
    ]);
    expect(c.studios).toEqual(['Big Studio']);
    expect(c.tags).toEqual(['Heist']);
    // the show carries the cast; its episodes have no own people (the castinfo route takes the regulars from the series)
    expect((await e.ms.credits(admin, item(3))).people[0]).toEqual({ id: tag(10), name: 'Teo Brandvik', role: 'Sam', type: 'Actor', image: false });
    expect((await e.ms.credits(admin, item(5))).people).toEqual([]);
    await expect(e.ms.credits(child, item(lib.adult!))).rejects.toMatchObject({ status: 404 });
  });

  it('migration 3 marks stale details so existing mirrors gain chapters and stream traits on the next pass', async () => {
    await e.pool.query('update plex_items set chapters = null, detail_at = null where rating_key = $1', [lib.chap]);
    await e.ms.sync.run();
    expect((await e.pool.query('select jsonb_array_length(chapters) n from plex_items where rating_key = $1', [lib.chap])).rows[0].n).toBe(3);
  });
});

// own databases (plexEnv resets the shared test DB): after the suite above
describe('Plex chapters capability edge cases', () => {
  it('chapters without generated thumbnails come without stills; no chapters anywhere -> capability off', async () => {
    const f2 = await plexEnv((f) => { f.addChapterMovie({ thumbs: false }); });
    try {
      const u = await identity(f2.ms, 'admin');
      expect((await f2.ms.chapters(u, item(15))).every((c) => c.image === undefined)).toBe(true);
      expect(f2.ms.capabilities.chapters).toBe(true);
    } finally {
      await f2.close();
    }
    const f3 = await plexEnv();
    try {
      expect(f3.ms.capabilities.chapters).toBe(false);
    } finally {
      await f3.close();
    }
  });
});
