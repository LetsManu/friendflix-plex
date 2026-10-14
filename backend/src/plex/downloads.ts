// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Downloads, preview clips and the playback health check on Plex.
 *
 * FriendFlix' preparer (downloadprep.ts) and preview builder (previews.ts) pull an fMP4 HLS stream (EXT-X-MAP init + fragments) through
 * mediaFetch(). Plex only produces MPEG-TS HLS, so the backend serves a VIRTUAL fMP4 playlist (paths under /ff-plex/, answered by
 * mediaFetch, never by Plex) whose segments are the Plex TS segments remuxed one by one with ffmpeg (stream copy):
 *   /ff-plex/fmp4/<session>/master.m3u8  -> one variant: media.m3u8
 *   /ff-plex/fmp4/<session>/media.m3u8   -> EXT-X-MAP init.mp4 + <n>.m4s for every Plex segment (starts the transcode lazily)
 *   /ff-plex/fmp4/<session>/init.mp4     -> ftyp+moov of the remuxed first segment
 *   /ff-plex/fmp4/<session>/<n>.m4s      -> moof+mdat of the remuxed segment n (absolute timestamps: -copyts, frag_discont)
 *   /ff-plex/hls/<session>/master.m3u8   -> plain TS master for the health check (variant = the Plex session playlist)
 * A stopped session (downloadprep pauses with stopEncoding) is restarted on the next segment request.
 */
import { spawn } from 'node:child_process';

/** ffmpeg behind an interface so tests need no binary. Args are an array (never a shell). */
export interface PlexFfmpeg {
  run(args: string[], input?: Buffer, opts?: { maxBytes?: number; timeoutMs?: number }): Promise<Buffer>;
}

export const spawnFfmpeg: PlexFfmpeg = {
  run(args, input, opts = {}) {
    const max = opts.maxBytes ?? 256 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      let size = 0;
      let err = '';
      const timer = setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs ?? 120_000);
      p.stdout!.on('data', (d: Buffer) => {
        size += d.length;
        if (size > max) p.kill('SIGKILL');
        else out.push(d);
      });
      p.stderr!.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-500); });
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', (code) => {
        clearTimeout(timer);
        if (size > max) return reject(new Error('ffmpeg output too large'));
        if (code === 0) resolve(Buffer.concat(out));
        else reject(new Error(`ffmpeg exit ${code}: ${err.trim()}`));
      });
      if (input && p.stdin) {
        p.stdin.on('error', () => undefined); // ffmpeg may exit before reading everything
        p.stdin.end(input);
      }
    });
  },
};

/** TS segment (stdin) -> fragmented MP4 with the source timestamps kept, so separately remuxed segments line up. */
export const TS_TO_FMP4_ARGS = [
  '-nostdin', '-v', 'error', '-protocol_whitelist', 'pipe', '-f', 'mpegts', '-i', 'pipe:0',
  '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-copyts', '-avoid_negative_ts', 'disabled',
  '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof+frag_discont+skip_trailer', 'pipe:1',
] as const;

/** Top-level MP4 boxes [type, start, end); stops at the first malformed box. */
export function mp4Boxes(buf: Buffer): Array<{ type: string; start: number; end: number }> {
  const out: Array<{ type: string; start: number; end: number }> = [];
  let p = 0;
  while (p + 8 <= buf.length) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (size === 1) {
      if (p + 16 > buf.length) break;
      size = Number(buf.readBigUInt64BE(p + 8));
    } else if (size === 0) size = buf.length - p;
    if (size < 8 || p + size > buf.length) break;
    out.push({ type, start: p, end: p + size });
    p += size;
  }
  return out;
}

/** Splits a remuxed segment into its init part (ftyp + moov) and its media part (moof + mdat only). */
export function splitFmp4(buf: Buffer): { init: Buffer; media: Buffer } {
  const boxes = mp4Boxes(buf);
  const moov = boxes.find((b) => b.type === 'moov');
  if (!moov) throw new Error('remux: no moov');
  const media = Buffer.concat(boxes.filter((b) => b.type === 'moof' || b.type === 'mdat').map((b) => buf.subarray(b.start, b.end)));
  if (!media.length) throw new Error('remux: no fragments');
  return { init: buf.subarray(0, moov.end), media };
}

/** Rewrites a Plex session playlist (relative NNNNN.ts lines) into the virtual fMP4 playlist. */
export function fmp4Playlist(plexIndex: string): { text: string; segments: number } {
  const lines = plexIndex.split(/\r?\n/);
  const out: string[] = [];
  let n = 0;
  let mapped = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#')) {
      if (/^#EXT-X-(MAP|KEY|SESSION-KEY|MEDIA|STREAM-INF|I-FRAME-STREAM-INF)(:|$)/i.test(l)) continue; // never relay URIs we did not produce
      out.push(l);
      if (!mapped && l.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
        out.push('#EXT-X-MAP:URI="init.mp4"');
        mapped = true;
      }
      continue;
    }
    if (!/^\d{1,6}\.ts$/.test(l)) throw new Error('unexpected playlist entry');
    out.push(`${Number(l.slice(0, -3))}.m4s`);
    n++;
  }
  if (!mapped) {
    const at = out.findIndex((l) => l.startsWith('#EXTINF'));
    out.splice(at < 0 ? out.length : at, 0, '#EXT-X-MAP:URI="init.mp4"');
  }
  const i = out.findIndex((l) => l.startsWith('#EXT-X-VERSION'));
  if (i >= 0) out.splice(i, 1);
  out.splice(1, 0, '#EXT-X-VERSION:7');
  return { text: out.join('\n') + '\n', segments: n };
}

export const VIRTUAL_RE = /^\/ff-plex\/(fmp4|hls)\/([0-9a-f]{16}-[0-9a-f]{24})\/(master\.m3u8|media\.m3u8|init\.mp4|\d{1,6}\.m4s)$/;
export const virtualMaster = (kind: 'fmp4' | 'hls', session: string) => `/ff-plex/${kind}/${session}/master.m3u8`;
