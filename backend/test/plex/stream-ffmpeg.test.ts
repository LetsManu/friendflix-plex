// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Real ffmpeg (skipped without the binary): Plex-style MPEG-TS HLS segments remuxed one by one must concatenate into an fMP4 the
 * download preparer's final remux accepts, with the full duration; embedded text subtitles are extracted through the loopback proxy.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ffmpegArgs } from '../../src/downloadprep.js';
import { spawnFfmpeg, splitFmp4, TS_TO_FMP4_ARGS } from '../../src/plex/downloads.js';
import { extractEmbedded } from '../../src/plex/subtitles.js';
import type { PlexHttp } from '../../src/plex/transcode.js';

const has = (bin: string) => spawnSync(bin, ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'ff-plex-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const probe = (f: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());

describe.skipIf(!has('ffmpeg') || !has('ffprobe'))('ffmpeg remux / extraction', () => {
  it('TS segments -> per-segment fMP4 fragments (+ first init) -> final MP4 with the whole duration', async () => {
    // 4 x 2 s HLS/TS segments, H.264 + AAC (what Plex' Android profile produces), timestamps offset like Plex (+10 s)
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '8', '-c:v', 'libx264', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-output_ts_offset', '10', '-f', 'hls', '-hls_time', '2',
      '-hls_segment_filename', join(dir, '%05d.ts'), join(dir, 'index.m3u8')]);
    const segs = readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();
    expect(segs.length).toBeGreaterThanOrEqual(4);
    const parts: Buffer[] = [];
    for (const [n, f] of segs.entries()) {
      const { init, media } = splitFmp4(await spawnFfmpeg.run([...TS_TO_FMP4_ARGS], readFileSync(join(dir, f))));
      if (n === 0) parts.push(init);
      parts.push(media);
    }
    const part = join(dir, 'job.part');
    writeFileSync(part, Buffer.concat(parts));
    execFileSync('ffmpeg', ffmpegArgs(part, join(dir, 'out.mp4')));
    expect(probe(join(dir, 'out.mp4'))).toBeGreaterThan(7.5);
    expect(spawnSync('ffmpeg', ['-v', 'error', '-i', join(dir, 'out.mp4'), '-f', 'null', '-']).stderr.toString()).toBe('');
  }, 60_000);

  it('embedded SRT in an MKV part -> WebVTT through the loopback proxy (Range-capable)', async () => {
    const srt = join(dir, 's.srt');
    writeFileSync(srt, '1\n00:00:00,500 --> 00:00:01,500\nEmbedded hello\n');
    const mkv = join(dir, 'p.mkv');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-i', srt, '-t', '2', '-map', '0:v', '-map', '1:s', '-c:v', 'libx264', '-c:s', 'srt', mkv]);
    const file = readFileSync(mkv);
    const seen: string[] = [];
    const http: PlexHttp = {
      async fetch(path, init = {}) {
        seen.push(path);
        const range = new Headers(init.headers).get('range');
        const m = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
        if (!m) return new Response(new Uint8Array(file), { headers: { 'content-length': String(file.length), 'accept-ranges': 'bytes' } });
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), file.length - 1) : file.length - 1;
        return new Response(new Uint8Array(file.subarray(start, end + 1)), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${file.length}`, 'content-length': String(end - start + 1) } });
      },
    };
    const vtt = (await extractEmbedded(http, spawnFfmpeg, '7', 1)).toString();
    expect(vtt).toMatch(/^WEBVTT/);
    expect(vtt).toContain('00:00.500 --> 00:01.500');
    expect(vtt).toContain('Embedded hello');
    expect(seen.every((p) => p === '/library/parts/7/0/file')).toBe(true);
  }, 60_000);
});
