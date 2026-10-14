// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Why a Plex playback session is transcoded (PlaybackDto.transcodeReason, Block 20). Plex has no reason list like Jellyfin's
 * TranscodeReasons: the decision call answers per stream whether it is copied or converted (Metadata[0].Media[0].Part[0].Stream[].decision,
 * older answers also TranscodeSession.videoDecision / audioDecision). The reason is derived from what we know about the source
 * (container, codecs, bitrate, height) plus that decision:
 *
 *   1. video codec the browser cannot play (or > 8 bit), converted by Plex      -> videoCodec
 *   2. audio codec the browser cannot play, converted by Plex                  -> audioCodec
 *   3. source bitrate above the cap (Plex then converts the video at the cap)  -> the cap's reason (remoteCap / roleCap / manual / network)
 *   4. audio converted for another reason (channels, profile)                  -> audioCodec
 *   5. container only (video and audio copied into the HLS segments)           -> container
 *   6. a chosen, non-default audio track (direct play cannot switch tracks)    -> audioTrack
 *   7. unknown source bitrate and Plex converts the video                       -> the cap's reason
 *   8. source taller than the role's height cap                                -> height
 *   9. anything else (cast, a role without download rights, ...)               -> other
 *
 * Server reasons outrank caps as upstream does; the container ranks below the cap because Plex re-encodes the video for a bitrate cap
 * (the container is then no longer the reason). The cap's reason comes from routes/media.ts (PlaybackOptions.capReason).
 */
import type { PlaybackOptions, TranscodeReason } from '../media/types.js';

export const BROWSER_CONTAINER = /(^|,)(mp4|m4v|mov|webm)(,|$)/i;
export const DIRECT_VIDEO = new Set(['h264', 'vp9', 'av1']);
export const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'flac']);

/** What playbackInfo() knows about the source; stored with the session so preparePlayback() can refine it with the decision. */
export interface ReasonFacts {
  container: string;
  videoCodec: string;
  bitDepth: number;
  /** codec of the audio track that plays (chosen or default) */
  audioCodec: string;
  /** bit/s, 0 = unknown */
  srcBps: number;
  srcHeight: number;
  maxBitrate: number;
  maxHeight?: number | null;
  audioIndex?: number;
  capReason?: PlaybackOptions['capReason'];
}

/** Stream decisions of a Plex decision answer; undefined = not reported. */
export interface PlexDecision {
  video?: 'copy' | 'transcode';
  audio?: 'copy' | 'transcode';
}

const lc = (v: unknown) => String(v ?? '').toLowerCase();
const asDecision = (v: unknown): 'copy' | 'transcode' | undefined => {
  const s = lc(v);
  return s === 'copy' || s === 'directstream' ? 'copy' : s === 'transcode' || s === 'burn' ? 'transcode' : undefined;
};

/** Stream decisions from the JSON of GET /video/:/transcode/universal/decision (lenient: missing parts stay undefined). */
export function parseDecision(json: unknown): PlexDecision {
  const mc = (json as { MediaContainer?: Record<string, any> } | null)?.MediaContainer;
  if (!mc || typeof mc !== 'object') return {};
  const media = Array.isArray(mc.Metadata) ? mc.Metadata[0]?.Media : undefined;
  const part = Array.isArray(media) ? (media.find((m: any) => m?.selected) ?? media[0])?.Part?.[0] : undefined;
  const streams: Array<Record<string, unknown>> = Array.isArray(part?.Stream) ? part.Stream : [];
  const of = (type: number) => {
    const list = streams.filter((s) => Number(s.streamType) === type);
    return asDecision((list.find((s) => s.selected === true || s.selected === 1 || s.selected === '1') ?? list[0])?.decision);
  };
  const ts = Array.isArray(mc.TranscodeSession) ? mc.TranscodeSession[0] : mc.TranscodeSession;
  return { video: of(1) ?? asDecision(ts?.videoDecision), audio: of(2) ?? asDecision(ts?.audioDecision) };
}

export function plexTranscodeReason(f: ReasonFacts, d: PlexDecision = {}): TranscodeReason {
  const cap = f.capReason ?? 'network';
  const badVideo = !DIRECT_VIDEO.has(lc(f.videoCodec)) || f.bitDepth > 8;
  const badAudio = Boolean(f.audioCodec) && !DIRECT_AUDIO.has(lc(f.audioCodec));
  if (badVideo && d.video !== 'copy') return 'videoCodec';
  if (badAudio && d.audio !== 'copy') return 'audioCodec';
  if (f.srcBps > f.maxBitrate) return cap;
  // audio converted although the codec plays in a browser (channel count, a profile the Web client rejects)
  if (d.audio === 'transcode') return 'audioCodec';
  if (!BROWSER_CONTAINER.test(f.container)) return 'container';
  if (f.audioIndex !== undefined) return 'audioTrack';
  if (!f.srcBps && d.video === 'transcode') return cap;
  if (f.maxHeight && f.srcHeight > f.maxHeight) return 'height';
  return 'other';
}
