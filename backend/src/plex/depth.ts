/**
 * Block 17 parity for Plex (fork): pure mappers from the mirror (plex_items.media / .chapters, written by sync.ts) to the neutral
 * DTOs of the optional MediaServer methods mediaTraits / libraryMediaTraits (quality chips, 4K / HDR filter) and chapters
 * ("Szenen" panel, seek bar marks). No I/O here; service.ts does the visibility checks and the queries.
 */
import type { ChapterDto, MediaTraits } from '../media/types.js';
import { chapterImageUrl } from './mediapaths.js';

type Rec = Record<string, any>;

const RES_RANK = { sd: 0, hd: 1, '4k': 2 } as const;
const AUDIO_RANK = { mono: 0, stereo: 1, surround: 2, atmos: 3 } as const;
const HDR_RANK = { hlg: 1, hdr10: 2, hdr10plus: 3, dolbyvision: 4 } as const;

const text = (s: Rec) => `${s.displayTitle ?? ''} ${s.extendedDisplayTitle ?? ''} ${s.title ?? ''}`;

/** Dynamic range of one Plex video stream: Dolby Vision flag, else the transfer function (PQ = HDR10, HLG), else the display title. */
function hdrOf(v: Rec): MediaTraits['hdr'] {
  const t = text(v);
  if (v.DOVIPresent === true || v.DOVIPresent === 1 || v.DOVIPresent === '1' || /\bdovi\b|dolby\s*vision/i.test(t)) return 'dolbyvision';
  if (/hdr10\+|hdr10plus/i.test(t)) return 'hdr10plus';
  const trc = String(v.colorTrc ?? '').toLowerCase();
  if (trc === 'smpte2084' || /\bhdr10\b|\bhdr\b/i.test(t)) return 'hdr10';
  if (trc === 'arib-std-b67' || /\bhlg\b/i.test(t)) return 'hlg';
  return null;
}

/** One Plex media version (Media[i] with Part[].Stream[]) -> MediaTraits; null when it has no video stream / size. */
export function mediaVersionTraits(md: Rec): MediaTraits | null {
  const streams: Rec[] = (Array.isArray(md?.Part) ? md.Part : []).flatMap((p: Rec) => (Array.isArray(p?.Stream) ? p.Stream : []));
  const video = streams.find((s) => Number(s?.streamType) === 1);
  const w = Number(video?.width ?? md?.width ?? 0);
  const h = Number(video?.height ?? md?.height ?? 0);
  const vr = String(md?.videoResolution ?? '').toLowerCase();
  if (!video && !w && !h && !vr) return null;
  // like the Jellyfin mapping: cropped widescreen (3840x1600) is still 4K
  const resolution: MediaTraits['resolution'] = h >= 1800 || w >= 3200 || vr === '4k' ? '4k'
    : h >= 700 || w >= 1200 || vr === '720' || vr === '1080' ? 'hd' : 'sd';
  const audioStreams = streams.filter((s) => Number(s?.streamType) === 2);
  const atmos = audioStreams.some((s) => /atmos/i.test(`${text(s)} ${s.profile ?? ''}`));
  const ch = audioStreams.length ? Math.max(...audioStreams.map((s) => Number(s.channels ?? 0) || 0)) : Number(md?.audioChannels ?? 0) || 0;
  const audio: MediaTraits['audio'] = atmos ? 'atmos' : ch > 2 ? 'surround' : ch === 2 ? 'stereo' : ch === 1 ? 'mono' : null;
  return { resolution, hdr: video ? hdrOf(video) : null, audio };
}

/** Best of two trait sets (every axis on its own: a title with a 4K SDR and a 1080p HDR version reports 4K + HDR). */
export function bestTraits(a: MediaTraits | null, b: MediaTraits | null): MediaTraits | null {
  if (!a || !b) return a ?? b;
  return {
    resolution: RES_RANK[b.resolution] > RES_RANK[a.resolution] ? b.resolution : a.resolution,
    hdr: !a.hdr ? b.hdr : !b.hdr ? a.hdr : HDR_RANK[b.hdr] > HDR_RANK[a.hdr] ? b.hdr : a.hdr,
    audio: !a.audio ? b.audio : !b.audio ? a.audio : AUDIO_RANK[b.audio] > AUDIO_RANK[a.audio] ? b.audio : a.audio,
  };
}

/** All media versions of an item (plex_items.media) -> its best traits; null without any video. */
export const plexTraits = (media: Rec[] | null | undefined): MediaTraits | null =>
  (Array.isArray(media) ? media : []).reduce<MediaTraits | null>((acc, md) => bestTraits(acc, mediaVersionTraits(md)), null);

/** A mirrored chapter (mirror.ts chaptersOf). */
export interface MirrorChapter { start: number; name: string; media?: string; index?: number }

const GENERIC = /^(chapter|kapitel|chapitre|cap[ií]tulo|capitolo|b[öo]l[üu]m|rozdzia[łl])\s*\d+$/i;

/**
 * Mirror chapters -> ChapterDto (seconds, 0.1 s precision), sorted, one per start. Generic names ("Chapter 3") become '' so the web
 * shows its own localized "Kapitel 3". A still only when PMS generated chapter thumbnails AND a signing secret is configured
 * (the gateway verifies the media id binding, see mediapaths.ts).
 */
export function chapterDtos(itemId: string, raw: MirrorChapter[] | null | undefined, secret?: string): ChapterDto[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  return raw
    .filter((c) => c && Number.isFinite(c.start) && c.start >= 0)
    .map((c): ChapterDto => ({
      start: Math.round(c.start / 100) / 10,
      name: GENERIC.test(c.name ?? '') ? '' : (c.name ?? ''),
      ...(secret && c.media && /^\d{1,18}$/.test(c.media) && Number.isInteger(c.index) && c.index! >= 0 && c.index! < 10_000
        ? { image: chapterImageUrl(secret, itemId, c.media, c.index!) } : {}),
    }))
    .sort((a, b) => a.start - b.start)
    .filter((c) => (seen.has(c.start) ? false : (seen.add(c.start), true)))
    .slice(0, 200);
}
