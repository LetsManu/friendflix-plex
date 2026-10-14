// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Timeline previews from Plex BIF index files (Part.indexes = "sd"; needs GenerateBIFBehavior != never on the server, no Plex Pass).
 * Plex serves single JPEG frames at /library/parts/<id>/indexes/sd/<ms>, so the DTO describes 1x1 "tiles": sheet n = frame n, its
 * time n * interval. Count and interval come from the BIF header (first 72 bytes via Range; verified 206 on PMS 1.43):
 *   magic 89 42 49 46 0d 0a 1a 0a | u32 version | u32 frame count | u32 timestamp multiplier (0 = 1000 ms) | ... | index @64:
 *   (u32 timestamp, u32 offset) per frame.
 */
import type { TrickplayDto } from '../media/types.js';
import { trickplayUrl } from './mediapaths.js';
import type { PlexHttp } from './transcode.js';

const MAGIC = Buffer.from([0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);
export const BIF_HEAD_BYTES = 80;

export interface BifInfo { count: number; intervalMs: number }

/** Parses the BIF header + the first two index entries; null when it is not a usable BIF. */
export function parseBifHeader(b: Uint8Array): BifInfo | null {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (buf.length < 80 || !buf.subarray(0, 8).equals(MAGIC)) return null;
  const count = buf.readUInt32LE(12);
  const mult = buf.readUInt32LE(16) || 1000;
  const t0 = buf.readUInt32LE(64);
  const t1 = buf.readUInt32LE(72);
  const interval = (t1 - t0) * mult;
  if (!count || count > 200_000 || !(interval >= 100 && interval <= 600_000)) return null;
  return { count, intervalMs: interval };
}

/** Frame size: Plex index frames are 320 px wide, height follows the video's aspect ratio. */
export function trickplayDto(secret: string, itemId: string, partId: string, bif: BifInfo, video: { width?: number; height?: number }): TrickplayDto {
  const w = 320;
  const h = video.width && video.height ? Math.max(2, Math.round((w * video.height) / video.width / 2) * 2) : 180;
  return { width: w, height: h, tileWidth: 1, tileHeight: 1, count: bif.count, interval: bif.intervalMs, url: trickplayUrl(secret, itemId, partId, bif.intervalMs) };
}

/** BIF header of a part (memoised per part, misses for 10 min). */
export class BifLookup {
  private readonly m = new Map<string, { exp: number; v: Promise<BifInfo | null> }>();
  constructor(private readonly http: PlexHttp) {}
  get(partKey: string): Promise<BifInfo | null> {
    const hit = this.m.get(partKey);
    if (hit && hit.exp > Date.now()) return hit.v;
    const v = (async () => {
      const r = await this.http.fetch(`/library/parts/${partKey}/indexes/sd`, { headers: { range: `bytes=0-${BIF_HEAD_BYTES - 1}`, accept: '*/*' } });
      if (r.status !== 206 && r.status !== 200) {
        await r.arrayBuffer().catch(() => undefined);
        return null;
      }
      // a server that ignores Range sends the whole file: read only the head
      const reader = r.body?.getReader();
      const chunks: Uint8Array[] = [];
      let n = 0;
      while (reader && n < BIF_HEAD_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        n += value.length;
      }
      await reader?.cancel().catch(() => undefined);
      return parseBifHeader(Buffer.concat(chunks).subarray(0, BIF_HEAD_BYTES));
    })().catch(() => null);
    this.m.set(partKey, { exp: Date.now() + 600_000, v });
    if (this.m.size > 2000) this.m.clear();
    return v;
  }
}
