// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The body of POST /api/playback/info, built in ONE place for the player and for the prefetch on the play buttons
 * (lib/player/prefetch.ts): the prefetched answer is only reused when both bodies are identical.
 */
import { autoBps } from './abr';
import { loadStoredEstimate } from './bandwidth';
import { firstInfoBody } from './bar';

/** /api/playback/info answer (backend PlaybackDto) as far as the web player uses it */
export interface PlaybackDto {
  playSessionId: string; mediaSourceId: string; directUrl?: string; hlsUrl: string; resumeTicks: number; maxBitrate: number;
  roleMaxBitrate?: number;
  /** why the server transcodes (absent on direct play) */
  transcodeReason?: string;
  trickplay?: { width: number; height: number; tileWidth: number; tileHeight: number; count: number; interval: number; url: string };
  /** audio track the server baked into hlsUrl (audioLang matched a non-default track) */
  audioIndex?: number;
  audioTracks: Array<{ index: number; title: string; isDefault: boolean; language?: string }>;
  subtitles: Array<{ index: number; title: string; url: string; language?: string; isDefault: boolean }>;
}

export type ReasonHint = 'network' | 'manual';
export interface InfoBody { itemId: string; startTicks?: number; audioIndex?: number; maxBitrate?: number; reasonHint: ReasonHint; audioLang?: string }

/** seconds -> Jellyfin ticks (same rounding as secToTicks in lib/api) */
const ticks = (sec: number) => Math.floor(sec * 10_000_000);

/** bps = Infinity asks for the original (no maxBitrate); undefined fields are left out, like JSON.stringify does */
export function playbackInfoBody(o: { itemId: string; startSec?: number; audioIndex?: number; bps: number; hint: ReasonHint; audioLang?: string }): InfoBody {
  const b: InfoBody = { itemId: o.itemId, reasonHint: o.hint };
  if (o.startSec !== undefined) b.startTicks = ticks(o.startSec);
  if (o.audioIndex !== undefined) b.audioIndex = o.audioIndex;
  if (Number.isFinite(o.bps)) b.maxBitrate = o.bps;
  if (o.audioLang) b.audioLang = o.audioLang;
  return b;
}

/**
 * The first request of a player session: the saved quality (a pick = 'manual') or the rung for the remembered bandwidth
 * estimate ('network'), plus the preferred audio language (`audioPick` = detail-page pick / series choice wins over the profile default).
 */
export function firstPlaybackRequest(itemId: string, pf: { quality?: number; audioLang?: string }, audioPick = '', startSec?: number): { body: InfoBody; quality: number; hint: ReasonHint; bps: number } {
  const fb = firstInfoBody(pf, audioPick);
  const quality = fb.maxBitrate ?? 0;
  const hint: ReasonHint = quality ? 'manual' : 'network';
  const bps = quality || autoBps(loadStoredEstimate());
  return { body: playbackInfoBody({ itemId, startSec, bps, hint, audioLang: fb.audioLang }), quality, hint, bps };
}

/** order-independent comparison key of a body (undefined fields do not count) */
export function bodyKey(b: object): string {
  const o = b as Record<string, unknown>;
  return JSON.stringify(Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => [k, o[k]]));
}
