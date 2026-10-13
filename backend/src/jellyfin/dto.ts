/** Jellyfin JSON -> the server-neutral DTOs of ../media/types.ts (re-exported here for existing imports). */
import { DOWNLOAD_PRESETS, maxWidthFor, type DownloadQuality, type DownloadSourceDto, type ImageTags, type ItemDto, type MediaTraits, type PlaybackDto, type TranscodeReason, type TrickplayDto } from '../media/types.js';
import type { ChapterDto, ItemAboutDto, ItemCreditsDto, ProviderIds } from '../media/types.js'; // Block 17 P1

export { DOWNLOAD_PRESETS, maxWidthFor };
export type { DownloadQuality, DownloadSourceDto, ImageTags, ItemDto, PlaybackDto, TrickplayDto };

const tagStr = (v: unknown) => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : undefined);

function imageTags(i: Record<string, any>): ImageTags | undefined {
  const t: ImageTags = {
    primary: tagStr(i.ImageTags?.Primary),
    backdrop: Array.isArray(i.BackdropImageTags) ? tagStr(i.BackdropImageTags[0]) : undefined,
    logo: tagStr(i.ImageTags?.Logo),
    thumb: tagStr(i.ImageTags?.Thumb),
    seriesPrimary: tagStr(i.SeriesPrimaryImageTag),
  };
  for (const k of Object.keys(t) as Array<keyof ImageTags>) if (t[k] === undefined) delete t[k];
  return Object.keys(t).length ? t : undefined;
}

export function toItemDto(i: Record<string, any>): ItemDto {
  const ud = i.UserData ?? {};
  return {
    id: i.Id,
    name: i.Name,
    type: i.Type,
    year: i.ProductionYear,
    overview: i.Overview,
    runtimeTicks: i.RunTimeTicks,
    seriesId: i.SeriesId,
    seriesName: i.SeriesName,
    seasonId: i.SeasonId,
    indexNumber: i.IndexNumber,
    parentIndexNumber: i.ParentIndexNumber,
    genres: Array.isArray(i.Genres) ? i.Genres : [],
    rating: i.OfficialRating,
    communityRating: i.CommunityRating,
    premiereDate: i.PremiereDate,
    dateCreated: i.DateCreated,
    image: Boolean(i.ImageTags?.Primary),
    backdrop: Array.isArray(i.BackdropImageTags) && i.BackdropImageTags.length > 0,
    logo: Boolean(i.ImageTags?.Logo),
    trailers: Number(i.LocalTrailerCount ?? 0),
    played: Boolean(ud.Played),
    favorite: Boolean(ud.IsFavorite),
    positionTicks: Number(ud.PlaybackPositionTicks ?? 0),
    playedPercentage: ud.PlayedPercentage,
    lastPlayedDate: ud.LastPlayedDate,
    childCount: i.ChildCount,
    unplayedCount: ud.UnplayedItemCount,
    lastAdded: i.DateLastMediaAdded,
    imageTags: imageTags(i),
  };
}

const TEXT_SUBS = new Set(['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'mov_text', 'subviewer']);

const AUDIO_BITRATE = 192_000;
const MIN_VIDEO_BITRATE = 300_000;

const REASON_MAP: Record<string, TranscodeReason | 'bitrate'> = {
  ContainerNotSupported: 'container',
  VideoCodecNotSupported: 'videoCodec',
  AudioCodecNotSupported: 'audioCodec',
  AudioChannelsNotSupported: 'audioCodec',
  SubtitleCodecNotSupported: 'subtitles',
  VideoResolutionNotSupported: 'height',
  ContainerBitrateExceedsLimit: 'bitrate',
  VideoBitrateNotSupported: 'bitrate',
};
/** codec/container reasons outrank a cap, a cap outranks Jellyfin's bitrate reasons */
const REASON_ORDER: TranscodeReason[] = ['container', 'videoCodec', 'audioCodec', 'subtitles', 'height'];

function transcodeReasonOf(
  src: Record<string, any>,
  o: { audioIndex?: number; capReason?: TranscodeReason; maxBitrate: number; noDirect?: boolean; maxHeight?: number | null; srcHeight: number },
): TranscodeReason {
  const url = String(src.TranscodingUrl ?? '');
  const raw = url.includes('?') ? new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('TranscodeReasons') : null;
  const mapped = (raw ?? '').split(',').map((r) => r.trim()).filter(Boolean).map((r) => REASON_MAP[r] ?? 'other');
  const hard = REASON_ORDER.find((r) => mapped.includes(r));
  if (hard) return hard;
  const srcBitrate = Number(src.Bitrate ?? 0);
  // our cap is blamed only when it really lies below the source (it outranks the audio track: a remote limit must not read as "audio track");
  // a bitrate reason with the cap above it is a plain network/device limit
  if (srcBitrate > o.maxBitrate) return o.capReason ?? 'network';
  if (o.audioIndex !== undefined) return 'audioTrack';
  if (mapped.includes('bitrate') && !srcBitrate) return o.capReason ?? 'network';
  if (mapped.includes('bitrate')) return 'network';
  if (o.maxHeight && o.srcHeight > o.maxHeight) return 'height';
  return 'other';
}

export function toPlaybackDto(args: {
  itemId: string;
  info: Record<string, any>;
  deviceId: string;
  maxBitrate: number;
  resumeTicks: number;
  audioIndex?: number;
  /** role resolution cap (px); null/undefined = none */
  maxHeight?: number | null;
  /** Chromecast: AAC-only stereo, H.264 <= level 4.1 / 8 bit, never direct play */
  cast?: boolean;
  /** no direct URL (role with a height cap or without download rights: the gateway refuses direct streams for it) */
  noDirect?: boolean;
  /** which of our caps is the lowest one (bitrate reasons from the server are attributed to it) */
  capReason?: 'remoteCap' | 'roleCap' | 'manual' | 'network';
}): PlaybackDto {
  const { itemId, info, deviceId, maxBitrate, resumeTicks, audioIndex, maxHeight, cast, noDirect, capReason } = args;
  const src = (info.MediaSources ?? [])[0];
  if (!src) throw new Error('no media source');
  const streams: Array<Record<string, any>> = src.MediaStreams ?? [];
  const common = new URLSearchParams({ MediaSourceId: src.Id, PlaySessionId: info.PlaySessionId, DeviceId: deviceId });

  const hls = new URLSearchParams(common);
  hls.set('VideoCodec', 'h264');
  hls.set('AudioCodec', cast ? 'aac' : 'aac,mp3');
  hls.set('SegmentContainer', 'ts');
  hls.set('MinSegments', '1');
  hls.set('BreakOnNonKeyFrames', 'true');
  hls.set('TranscodingMaxAudioChannels', '2');
  hls.set('MaxStreamingBitrate', String(maxBitrate));
  if (audioIndex !== undefined) hls.set('AudioStreamIndex', String(audioIndex));
  // Explicit budgets: otherwise Jellyfin subtracts the SOURCE audio bitrate (TrueHD / DTS-HD MA: several Mbit/s) and starves the video
  hls.set('AudioBitrate', String(AUDIO_BITRATE));
  hls.set('AudioChannels', '2');
  hls.set('VideoBitrate', String(Math.max(MIN_VIDEO_BITRATE, maxBitrate - AUDIO_BITRATE)));
  const rungHeight = maxBitrate >= 8e6 ? 1080 : maxBitrate >= 4e6 ? 720 : maxBitrate >= 1.5e6 ? 480 : 360;
  const height = maxHeight ? Math.min(rungHeight, maxHeight) : rungHeight;
  hls.set('MaxHeight', String(height));
  hls.set('MaxWidth', String(maxWidthFor(height)));
  if (cast) {
    // keep Jellyfin from stream-copying a source the Default Media Receiver cannot decode (H.264 > level 4.1, 10 bit)
    hls.set('Level', '41');
    hls.set('MaxVideoBitDepth', '8');
    hls.set('RequireAvc', 'true');
  }
  const srcHeight = Number(streams.find((s) => s.Type === 'Video')?.Height ?? 0);
  const withinCap = !maxHeight || (srcHeight > 0 && srcHeight <= maxHeight); // direct play must not bypass the cap (unknown height = no direct)

  const browserContainer = /(^|,)(mp4|m4v|webm|mov)(,|$)/i.test(String(src.Container ?? ''));
  const directOk = !cast && !noDirect && Boolean(src.SupportsDirectPlay) && browserContainer && Number(src.Bitrate ?? 0) <= maxBitrate && audioIndex === undefined && withinCap;
  const direct = new URLSearchParams(common);
  direct.set('static', 'true');

  const transcodeReason = directOk ? undefined : transcodeReasonOf(src, { audioIndex, capReason, maxBitrate, noDirect, maxHeight, srcHeight });

  return {
    itemId,
    playSessionId: info.PlaySessionId,
    mediaSourceId: src.Id,
    directUrl: directOk ? `/media/Videos/${itemId}/stream?${direct}` : undefined,
    hlsUrl: `/media/Videos/${itemId}/master.m3u8?${hls}`,
    runtimeTicks: src.RunTimeTicks,
    resumeTicks,
    maxBitrate,
    ...(transcodeReason ? { transcodeReason } : {}),
    ...(audioIndex !== undefined ? { audioIndex } : {}),
    audioTracks: streams
      .filter((s) => s.Type === 'Audio')
      .map((s) => ({ index: s.Index, language: s.Language, title: s.DisplayTitle ?? s.Title ?? s.Language ?? `Spur ${s.Index}`, isDefault: Boolean(s.IsDefault) })),
    subtitles: streams
      .filter((s) => s.Type === 'Subtitle' && (s.IsTextSubtitleStream || TEXT_SUBS.has(String(s.Codec ?? '').toLowerCase())))
      .map((s) => ({
        index: s.Index,
        language: s.Language,
        title: s.DisplayTitle ?? s.Title ?? s.Language ?? `Untertitel ${s.Index}`,
        isDefault: Boolean(s.IsDefault),
        url: `/media/Videos/${itemId}/${src.Id}/Subtitles/${s.Index}/0/Stream.vtt`,
      })),
  };
}

/** Picks the resolution closest to ~320 px from Jellyfin's `Trickplay[mediaSourceId][width]` map. */
export function toTrickplayDto(itemId: string, mediaSourceId: string, raw: Record<string, any> | undefined): TrickplayDto | undefined {
  const forSource = raw?.[mediaSourceId] ?? (raw ? Object.values(raw)[0] : undefined);
  if (!forSource || typeof forSource !== 'object') return undefined;
  const widths = Object.keys(forSource).map(Number).filter((w) => w >= 40 && w <= 2000);
  if (!widths.length) return undefined;
  const w = widths.reduce((a, b) => (Math.abs(b - 320) < Math.abs(a - 320) ? b : a));
  const t = forSource[String(w)];
  if (!t || !t.TileWidth || !t.TileHeight || !t.Interval || !t.ThumbnailCount) return undefined;
  return {
    width: Number(t.Width ?? w), height: Number(t.Height), tileWidth: Number(t.TileWidth), tileHeight: Number(t.TileHeight),
    count: Number(t.ThumbnailCount), interval: Number(t.Interval),
    url: `/media/Videos/${itemId}/Trickplay/${w}/{n}.jpg?MediaSourceId=${encodeURIComponent(mediaSourceId)}`,
  };
}

export function toDownloadSource(args: {
  itemId: string;
  info: Record<string, any>;
  deviceId: string;
  quality: DownloadQuality;
  audioIndex?: number;
  maxHeight?: number | null;
  maxBitrate?: number | null;
}): DownloadSourceDto {
  const { itemId, info, deviceId, quality, audioIndex, maxHeight, maxBitrate } = args;
  const src = (info.MediaSources ?? [])[0];
  if (!src) throw new Error('no media source');
  const streams: Array<Record<string, any>> = src.MediaStreams ?? [];
  const audioStreams = streams.filter((s) => s.Type === 'Audio');
  const video = streams.find((s) => s.Type === 'Video');
  const defAudio = audioStreams.find((s) => s.IsDefault) ?? audioStreams[0];
  const srcHeight = Number(video?.Height ?? 0);
  const originalEligible =
    /(^|,)(mp4|m4v)(,|$)/i.test(String(src.Container ?? '')) &&
    String(video?.Codec ?? '').toLowerCase() === 'h264' &&
    Number(video?.BitDepth ?? 8) <= 8 &&
    Boolean(defAudio) && ['aac', 'mp3'].includes(String(defAudio?.Codec ?? '').toLowerCase()) &&
    (audioIndex === undefined || audioIndex === defAudio?.Index) &&
    (!maxHeight || (srcHeight > 0 && srcHeight <= maxHeight)) &&
    (!maxBitrate || (Number(src.Bitrate ?? 0) > 0 && Number(src.Bitrate) <= maxBitrate)) &&
    Number(src.Size ?? 0) > 0;

  const runtimeSec = Number(src.RunTimeTicks ?? 0) / 1e7;
  const preset = quality === 'original' ? undefined : DOWNLOAD_PRESETS[quality];
  const audioBps = preset?.audioBps ?? 128_000;
  const totalBps = maxBitrate ?? (preset ? preset.videoBps + preset.audioBps : 0);
  const sizeBytes = quality === 'original' ? Number(src.Size ?? 0) : Math.round((runtimeSec * totalBps) / 8);

  let masterPath: string | undefined;
  if (quality !== 'original') {
    const q = new URLSearchParams({ MediaSourceId: src.Id, PlaySessionId: info.PlaySessionId, DeviceId: deviceId });
    const height = maxHeight ?? preset!.height;
    const entries: Record<string, string> = {
      VideoCodec: 'h264', AudioCodec: 'aac', SegmentContainer: 'mp4', TranscodingMaxAudioChannels: '2', MaxVideoBitDepth: '8',
      RequireAvc: 'true', Level: '40', BreakOnNonKeyFrames: 'false', MaxHeight: String(height), MaxWidth: String(maxWidthFor(height)),
      VideoBitrate: String(Math.max(totalBps - audioBps, 200_000)), AudioBitrate: String(audioBps), MaxStreamingBitrate: String(totalBps),
      AllowVideoStreamCopy: 'false', AllowAudioStreamCopy: 'false',
    };
    for (const [k, v] of Object.entries(entries)) q.set(k, v);
    if (audioIndex !== undefined) q.set('AudioStreamIndex', String(audioIndex));
    masterPath = `/Videos/${itemId}/master.m3u8?${q}`;
  }
  return {
    mediaSourceId: src.Id,
    originalEligible,
    sizeBytes,
    runtimeTicks: src.RunTimeTicks,
    playSessionId: info.PlaySessionId,
    audio: audioStreams.map((s) => ({ index: s.Index, lang: String(s.Language ?? 'und'), title: s.DisplayTitle ?? s.Title ?? s.Language ?? `Spur ${s.Index}`, isDefault: Boolean(s.IsDefault) })),
    subtitles: streams
      .filter((s) => s.Type === 'Subtitle' && (s.IsTextSubtitleStream || TEXT_SUBS.has(String(s.Codec ?? '').toLowerCase())))
      .map((s) => ({
        index: s.Index, lang: String(s.Language ?? 'und'), title: s.DisplayTitle ?? s.Title ?? s.Language ?? `Untertitel ${s.Index}`,
        url: `/media/Videos/${itemId}/${src.Id}/Subtitles/${s.Index}/0/Stream.vtt`,
      })),
    masterPath,
  };
}

// ---- Block 17 D1: media traits ---------------------------------------------------------------------------------------------------
/** Jellyfin MediaStreams (of one file) -> the neutral MediaTraits; null when there is no video stream. */
export function toMediaTraits(streams: Array<Record<string, any>> | undefined): MediaTraits | null {
  const list = Array.isArray(streams) ? streams : [];
  const video = list.find((s) => s?.Type === 'Video');
  if (!video) return null;
  const w = Number(video.Width ?? 0);
  const h = Number(video.Height ?? 0);
  // widescreen films are cropped (3840x1600 is still "4K"): judge by whichever side is large enough
  const resolution: MediaTraits['resolution'] = h >= 1800 || w >= 3200 ? '4k' : h >= 700 || w >= 1200 ? 'hd' : 'sd';
  const range = String(video.VideoRangeType ?? '').toLowerCase();
  const hdr: MediaTraits['hdr'] = range.startsWith('dovi') && range !== 'doviinvalid' ? 'dolbyvision'
    : range === 'hdr10plus' ? 'hdr10plus'
    : range === 'hdr10' ? 'hdr10'
    : range === 'hlg' ? 'hlg'
    : !range && String(video.VideoRange ?? '').toUpperCase() === 'HDR' ? 'hdr10'
    : null;
  const audioStreams = list.filter((s) => s?.Type === 'Audio');
  const best = audioStreams.reduce<Record<string, any> | undefined>((a, s) => (!a || Number(s.Channels ?? 0) > Number(a.Channels ?? 0) ? s : a), undefined);
  const atmos = audioStreams.some((s) => String(s.AudioSpatialFormat ?? '').toLowerCase() === 'dolbyatmos' || /atmos/i.test(`${s.Profile ?? ''} ${s.DisplayTitle ?? ''} ${s.Title ?? ''}`));
  const ch = Number(best?.Channels ?? 0);
  const audio: MediaTraits['audio'] = atmos ? 'atmos' : ch >= 6 ? 'surround' : ch === 2 ? 'stereo' : ch === 1 ? 'mono' : ch > 2 ? 'surround' : null;
  return { resolution, hdr, audio };
}
const RES_RANK = { sd: 0, hd: 1, '4k': 2 } as const;
const AUDIO_RANK = { mono: 0, stereo: 1, surround: 2, atmos: 3 } as const;
/** Best of two trait sets (a series reports its best episode). */
export function bestTraits(a: MediaTraits | null, b: MediaTraits | null): MediaTraits | null {
  if (!a || !b) return a ?? b;
  return {
    resolution: RES_RANK[b.resolution] > RES_RANK[a.resolution] ? b.resolution : a.resolution,
    hdr: a.hdr ?? b.hdr, // any HDR flavour beats none; Dolby Vision is only kept when it is the first one seen
    audio: !a.audio ? b.audio : !b.audio ? a.audio : AUDIO_RANK[b.audio] > AUDIO_RANK[a.audio] ? b.audio : a.audio,
  };
}

// ---- Block 17 P1: chapters + credits ---------------------------------------------------------------------------------------------
/**
 * Jellyfin `Chapters` (fields=Chapters) -> ChapterDto, sorted, duplicates by start dropped. Stills: /Items/<id>/Images/Chapter/<index>
 * (the index is the position in Jellyfin's own list, so it is taken before sorting). Generic names Jellyfin invents for files without
 * chapters ("Chapter 1", "Kapitel 01") become '' so the web shows its own localized "Kapitel 1".
 */
export function toChapters(itemId: string, raw: Array<Record<string, any>> | undefined): ChapterDto[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  return raw
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c && Number.isFinite(Number(c.StartPositionTicks)) && Number(c.StartPositionTicks) >= 0)
    .map(({ c, i }): ChapterDto => {
      const name = typeof c.Name === 'string' ? c.Name.trim().slice(0, 120) : '';
      return {
        start: Math.round(Number(c.StartPositionTicks) / 1e6) / 10, // 0.1 s precision
        name: /^(chapter|kapitel|chapitre|cap[ií]tulo|capitolo|b[öo]l[üu]m|rozdzia[łl])\s*\d+$/i.test(name) ? '' : name,
        ...(typeof c.ImageTag === 'string' && c.ImageTag ? { image: `/media/Items/${itemId}/Images/Chapter/${i}?tag=${encodeURIComponent(c.ImageTag)}&maxWidth=320&quality=80` } : {}),
      };
    })
    .sort((a, b) => a.start - b.start)
    .filter((c) => (seen.has(c.start) ? false : (seen.add(c.start), true)))
    .slice(0, 200);
}

/** Jellyfin People / Studios / Tags (fields=People,Studios,Tags) -> ItemCreditsDto. */
export function toCredits(raw: Record<string, any> | undefined): ItemCreditsDto {
  const people = (Array.isArray(raw?.People) ? raw!.People : []) as Array<Record<string, any>>;
  return {
    people: people
      .filter((p) => typeof p?.Id === 'string' && typeof p?.Name === 'string')
      .slice(0, 80)
      .map((p) => ({ id: p.Id, name: p.Name, ...(p.Role ? { role: String(p.Role) } : {}), type: String(p.Type ?? 'Actor'), image: Boolean(p.PrimaryImageTag) })),
    studios: (Array.isArray(raw?.Studios) ? raw!.Studios : []).map((s: any) => (typeof s === 'string' ? s : s?.Name)).filter((s: unknown): s is string => typeof s === 'string' && Boolean(s)).slice(0, 6),
    tags: (Array.isArray(raw?.Tags) ? raw!.Tags : []).filter((s: unknown): s is string => typeof s === 'string' && Boolean(s)).slice(0, 20),
  };
}

// ---- Block 21: detail page ------------------------------------------------------------------------------------------------------
/** Jellyfin ProviderIds (keys vary in case between versions) -> ProviderIds; empty values dropped. */
export function toProviderIds(raw: unknown): ProviderIds {
  const out: ProviderIds = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if ((key === 'imdb' || key === 'tmdb' || key === 'tvdb') && typeof v === 'string' && v.trim() && !out[key]) out[key] = v.trim();
  }
  return out;
}

/** Jellyfin item (fields=ProviderIds,Taglines,Studios,Tags,ProductionLocations,OriginalTitle) -> ItemAboutDto. */
export function toItemAbout(raw: Record<string, any>): ItemAboutDto {
  const strs = (a: unknown) => (Array.isArray(a) ? a : []).filter((s: unknown): s is string => typeof s === 'string' && Boolean(s));
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const tagline = strs(raw?.Taglines)[0];
  const original = typeof raw?.OriginalTitle === 'string' && raw.OriginalTitle ? raw.OriginalTitle : undefined;
  const critic = num(raw?.CriticRating), community = num(raw?.CommunityRating);
  return {
    type: String(raw?.Type ?? ''),
    providerIds: toProviderIds(raw?.ProviderIds),
    ...(tagline ? { tagline } : {}),
    ...(original ? { originalTitle: original } : {}),
    ...(typeof raw?.PremiereDate === 'string' && raw.PremiereDate ? { premiereDate: raw.PremiereDate } : {}),
    countries: strs(raw?.ProductionLocations),
    studios: (Array.isArray(raw?.Studios) ? raw.Studios : []).map((s: any) => (typeof s === 'string' ? s : s?.Name)).filter((s: unknown): s is string => typeof s === 'string' && Boolean(s)).slice(0, 6),
    tags: strs(raw?.Tags).slice(0, 20),
    ...(community !== undefined ? { communityRating: community } : {}),
    ...(critic !== undefined ? { criticRating: critic } : {}),
  };
}
