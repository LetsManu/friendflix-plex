import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DOWNLOAD_PRESETS, enqueueJob, ffmpegArgs, ffmpegRunner, gcDownloads, jobProgress, preparer, type FfmpegRunner } from '../src/downloadprep.js';
import { deleteLicense } from '../src/downloads.js';
import { setLive } from '../src/live.js';
import { previews } from '../src/previews.js';
import { toDownloadSource } from '../src/jellyfin/dto.js';
import { makeEnv, type TestEnv } from './helpers.js';

const MOVIE = 'a'.repeat(32);
const SEGS = 6;
const INIT = Buffer.from('INIT-SEGMENT');
const seg = (n: number) => Buffer.from(`<seg${n}>`);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let env: TestEnv;
let dir: string;
let requested: string[] = [];
let badSeg = -99;
let initBytes = INIT;
const remuxed: Buffer[] = [];
const runner: FfmpegRunner = { remux: async (input, output) => { remuxed.push(readFileSync(input)); await copyFile(input, output); } };

const jobs = {
  async create(over: Record<string, unknown> = {}) {
    const id = randomUUID();
    const r = { quality: 'hd', audio_lang: '', status: 'queued', seg_done: 0, seg_total: null, init_sha: null, bytes: null, ...over };
    await env.pool.query(
      'insert into download_jobs(id,item_id,quality,audio_lang,status,seg_done,seg_total,init_sha,bytes,max_height,max_bitrate) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [id, over.item_id ?? randomUUID().replace(/-/g, ''), r.quality, r.audio_lang, r.status, r.seg_done, r.seg_total, r.init_sha, r.bytes, over.max_height ?? 0, over.max_bitrate ?? 0],
    );
    return id;
  },
  /** a pending license waiting for the job (the job is only wanted while one exists) */
  async holder(jobId: string, over: { ageDays?: number; runtimeMin?: number } = {}) {
    const user = (await env.pool.query('select id from users limit 1')).rows[0].id;
    const prof = (await env.pool.query('select id from profiles where user_id = $1 limit 1', [user])).rows[0].id;
    const dev = (await env.pool.query('select device_id from devices where user_id = $1 limit 1', [user])).rows[0].device_id;
    const id = randomUUID();
    await env.pool.query(
      "insert into downloads(id,user_id,device_id,profile_id,item_id,job_id,quality,status,expires_at,created_at,meta) values ($1,$2,$3,$4,$5,$6,'hd','pending', now() + interval '30 days', now() - make_interval(days => $7), $8)",
      [id, user, dev, prof, randomUUID().replace(/-/g, ''), jobId, over.ageDays ?? 0, JSON.stringify({ runtimeTicks: (over.runtimeMin ?? 90) * 600_000_000 })],
    );
    return id;
  },
  get: async (id: string) => (await env.pool.query('select * from download_jobs where id = $1', [id])).rows[0],
};
const segRequests = () => requested.filter((x) => x.startsWith('seg'));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ff-dl-'));
  env = await makeEnv({
    'GET /Items/[^/]+': (u) => ({ json: { Id: u.pathname.split('/').pop(), Name: 'Der Film', Type: 'Movie', RunTimeTicks: 90 * 600_000_000, UserData: {} } }),
    'GET /Users/[^/]+/Items/[^/]+': (u) => ({ json: { Id: u.pathname.split('/').pop(), Name: 'Der Film', Type: 'Movie', RunTimeTicks: 90 * 600_000_000, UserData: {} } }),
    'POST /Items/[^/]+/PlaybackInfo': (u, _i, body) => ({
      json: {
        PlaySessionId: 'ps-dl-12345',
        MediaSources: [{
          Id: 'ms1', Container: 'mkv', Bitrate: 9_000_000, Size: 7_000_000_000, RunTimeTicks: 90 * 600_000_000,
          MediaStreams: [
            { Type: 'Video', Index: 0, Codec: 'hevc', Height: 1080, BitDepth: 10 },
            { Type: 'Audio', Index: 1, Codec: 'ac3', Language: 'eng', IsDefault: true },
            { Type: 'Audio', Index: 2, Codec: 'ac3', Language: 'ger' },
          ],
        }],
        _profile: body?.DeviceProfile?.Name,
        _path: u.pathname,
      },
    }),
    'GET /Videos/[^/]+/master.m3u8': (u) => { requested.push(`master${u.search}`); return { raw: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmain.m3u8?PlaySessionId=ps-dl-12345\n' }; },
    'GET /Videos/[^/]+/main.m3u8': () => ({ raw: `#EXTM3U\n#EXT-X-MAP:URI="hls1/main/-1.mp4"\n${Array.from({ length: SEGS }, (_, n) => `#EXTINF:6.0,\nhls1/main/${n}.mp4`).join('\n')}\n#EXT-X-ENDLIST\n` }),
    'GET /Videos/[^/]+/hls1/main/[^/]+': (u) => {
      const n = parseInt(u.pathname.split('/').pop()!, 10);
      requested.push(`seg${n}`);
      if (n === badSeg) return { status: 500, raw: 'boom' };
      return { raw: n < 0 ? initBytes : seg(n) };
    },
    'DELETE /Videos/ActiveEncodings': () => ({ status: 204 }),
  }, { ctxPatch: (c) => { c.cfg = { ...c.cfg, DOWNLOAD_DIR: dir, DOWNLOAD_PAUSE_STREAMS: 2 }; } });
  await env.login(); // creates the admin service user
  const p = preparer(env.ctx);
  p.runner = runner;
  p.sleep = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
  p.pollMs = 5;
});
afterAll(() => env.close());
beforeEach(async () => {
  requested = [];
  badSeg = -99;
  initBytes = INIT;
  remuxed.length = 0;
  env.jfCalls.length = 0;
  await env.pool.query('delete from notifications');
});

describe('jobProgress', () => {
  it('maps segments to percent, 99 until ready', () => {
    expect(jobProgress({ status: 'queued', seg_done: 0, seg_total: null })).toBe(0);
    expect(jobProgress({ status: 'preparing', seg_done: 34, seg_total: 100 })).toBe(34);
    expect(jobProgress({ status: 'preparing', seg_done: 100, seg_total: 100 })).toBe(99);
    expect(jobProgress({ status: 'ready', seg_done: 100, seg_total: 100 })).toBe(100);
  });
});

describe('preparer', () => {
  it('pulls init + all segments in order, remuxes, renames atomically, notifies license holders', async () => {
    const user = (await env.pool.query('select id from users limit 1')).rows[0].id;
    const prof = (await env.pool.query('select id from profiles where user_id = $1 limit 1', [user])).rows[0].id;
    const dev = (await env.pool.query('select device_id from devices where user_id = $1 limit 1', [user])).rows[0].device_id;
    const id = await jobs.create();
    await env.pool.query("insert into downloads(id,user_id,device_id,profile_id,item_id,job_id,quality,status,expires_at) values ($1,$2,$3,$4,$5,$6,'hd','pending', now() + interval '30 days')", [randomUUID(), user, dev, prof, MOVIE, id]);
    await enqueueJob(env.ctx, id);

    expect(segRequests()).toEqual(['seg-1', ...Array.from({ length: SEGS }, (_, i) => `seg${i}`)]);
    const q = new URL(requested.find((x) => x.startsWith('master'))!.slice(6), 'http://x').searchParams;
    expect(Object.fromEntries(q)).toMatchObject({
      SegmentContainer: 'mp4', VideoCodec: 'h264', AudioCodec: 'aac', TranscodingMaxAudioChannels: '2', MaxVideoBitDepth: '8', RequireAvc: 'true',
      Level: '40', BreakOnNonKeyFrames: 'false', MaxHeight: '720', AllowVideoStreamCopy: 'false', VideoBitrate: '2500000', AudioBitrate: '128000', PlaySessionId: 'ps-dl-12345',
    });
    expect(remuxed[0]!.toString()).toBe(INIT.toString() + Array.from({ length: SEGS }, (_, i) => seg(i).toString()).join(''));
    const file = join(dir, `${id}.mp4`);
    expect(readFileSync(file).equals(remuxed[0]!)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.startsWith(id))).toEqual([`${id}.mp4`]); // no .part / .tmp left
    const j = await jobs.get(id);
    expect(j).toMatchObject({ status: 'ready', seg_done: SEGS, seg_total: SEGS, init_sha: sha(INIT), error: null, play_session_id: 'ps-dl-12345' });
    expect(Number(j.bytes)).toBe(readFileSync(file).length);
    expect(env.jfCalls.some((c) => c.method === 'DELETE' && c.path === '/Videos/ActiveEncodings' && c.search.includes('playSessionId=ps-dl-12345'))).toBe(true);
    const n = (await env.pool.query("select user_id, link, title from notifications where kind = 'download_ready'")).rows;
    expect(n).toEqual([{ user_id: user, link: '/downloads', title: 'Download bereit' }]);
    expect(previews(env.ctx).downloadBusy).toBe(false);
  });

  it('is single-flight and skips finished jobs', async () => {
    const id = await jobs.create();
    await Promise.all([enqueueJob(env.ctx, id), enqueueJob(env.ctx, id)]);
    expect(requested.filter((x) => x.startsWith('master'))).toHaveLength(1);
    requested = [];
    await enqueueJob(env.ctx, id);
    expect(requested).toEqual([]);
  });

  it('resumes from seg_done when the init segment is unchanged', async () => {
    const id = await jobs.create({ status: 'preparing', seg_done: 3, seg_total: SEGS, init_sha: sha(INIT) });
    const head = Buffer.concat([INIT, seg(0), seg(1), seg(2)]);
    writeFileSync(join(dir, `${id}.part`), Buffer.concat([head, Buffer.from('<half')])); // torn write beyond the recorded size
    await env.pool.query('update download_jobs set bytes = $2 where id = $1', [id, head.length]);
    await enqueueJob(env.ctx, id);
    expect(segRequests()).toEqual(['seg-1', 'seg3', 'seg4', 'seg5']);
    expect(remuxed[0]!.toString()).toBe(INIT.toString() + [0, 1, 2, 3, 4, 5].map((n) => seg(n).toString()).join(''));
    expect((await jobs.get(id)).status).toBe('ready');
  });

  it('restarts from 0 when the init segment differs', async () => {
    const id = await jobs.create({ status: 'preparing', seg_done: 3, seg_total: SEGS, init_sha: sha(Buffer.from('OLD-INIT')) });
    const head = Buffer.concat([Buffer.from('OLD-INIT'), seg(0), seg(1), seg(2)]);
    writeFileSync(join(dir, `${id}.part`), head);
    await env.pool.query('update download_jobs set bytes = $2 where id = $1', [id, head.length]);
    await enqueueJob(env.ctx, id);
    expect(segRequests()).toEqual(['seg-1', ...Array.from({ length: SEGS }, (_, i) => `seg${i}`)]);
    expect(remuxed[0]!.toString().startsWith('INIT-SEGMENT<seg0>')).toBe(true);
    expect((await jobs.get(id)).init_sha).toBe(sha(INIT));
  });

  it('restarts from 0 when the partial file is missing', async () => {
    const id = await jobs.create({ status: 'preparing', seg_done: 2, seg_total: SEGS, init_sha: sha(INIT), bytes: 100 });
    await enqueueJob(env.ctx, id);
    expect(segRequests()).toHaveLength(SEGS + 1);
    expect((await jobs.get(id)).status).toBe('ready');
  });

  it('pauses between segments while live streams >= DOWNLOAD_PAUSE_STREAMS, stops the transcode, then continues', async () => {
    const live = (n: number) => ({ userId: `u${n}`, userName: 'x', itemId: 'i', title: 't', positionTicks: 0, isPaused: false, playSessionId: `p${n}`, updatedAt: Date.now(), source: 'portal' as const });
    await setLive(env.ctx, live(1), 60);
    await setLive(env.ctx, live(2), 60);
    const id = await jobs.create();
    await jobs.holder(id);
    const done = enqueueJob(env.ctx, id);
    const p = preparer(env.ctx);
    for (let i = 0; i < 200 && !p.pausedJobs.has(id); i++) await new Promise((r) => setTimeout(r, 5));
    expect(p.pausedJobs.has(id)).toBe(true);
    expect(segRequests().filter((x) => x !== 'seg-1')).toEqual([]); // nothing fetched while paused
    expect(env.jfCalls.some((c) => c.method === 'DELETE' && c.path === '/Videos/ActiveEncodings')).toBe(true); // transcode stopped at once
    await env.ctx.kv.del('play:u1:p1');
    await env.ctx.kv.del('play:u2:p2');
    await done;
    expect((await jobs.get(id)).status).toBe('ready');
  });

  it('pauses during the nightly playback check', async () => {
    const pv = previews(env.ctx);
    pv.paused = true;
    const id = await jobs.create();
    await jobs.holder(id);
    const done = enqueueJob(env.ctx, id);
    const p = preparer(env.ctx);
    for (let i = 0; i < 200 && !p.pausedJobs.has(id); i++) await new Promise((r) => setTimeout(r, 5));
    expect(p.pausedJobs.has(id)).toBe(true);
    pv.paused = false;
    await done;
    expect((await jobs.get(id)).status).toBe('ready');
  });

  it('fails the job on a broken segment and still stops the Jellyfin transcode', async () => {
    badSeg = 2;
    const id = await jobs.create();
    await enqueueJob(env.ctx, id);
    const j = await jobs.get(id);
    expect(j.status).toBe('failed');
    expect(j.error).toContain('500');
    expect(existsSync(join(dir, `${id}.part`))).toBe(false);
    expect(existsSync(join(dir, `${id}.mp4`))).toBe(false);
    expect(env.jfCalls.some((c) => c.method === 'DELETE' && c.path === '/Videos/ActiveEncodings')).toBe(true);
  });

  it('fails when ffmpeg fails, leaving no output', async () => {
    const p = preparer(env.ctx);
    const orig = p.runner;
    p.runner = { remux: async () => { throw new Error('ffmpeg exit 1: bad'); } };
    try {
      const id = await jobs.create();
      await enqueueJob(env.ctx, id);
      expect(await jobs.get(id)).toMatchObject({ status: 'failed', error: 'ffmpeg exit 1: bad' });
      expect(readdirSync(dir).filter((f) => f.startsWith(id))).toEqual([]);
      expect(env.jfCalls.some((c) => c.method === 'DELETE' && c.path === '/Videos/ActiveEncodings')).toBe(true);
    } finally {
      p.runner = orig;
    }
  });

  it('picks the audio track by language and clamps nothing for presets', async () => {
    const id = await jobs.create({ quality: 'sd', audio_lang: 'ger' });
    await enqueueJob(env.ctx, id);
    const m = requested.find((x) => x.startsWith('master'))!;
    const q = new URL(m.slice(6), 'http://x').searchParams;
    expect(q.get('AudioStreamIndex')).toBe('2');
    expect(q.get('MaxHeight')).toBe(String(DOWNLOAD_PRESETS.sd.height));
    const info = env.jfCalls.filter((c) => c.path.endsWith('/PlaybackInfo')).at(-1)!;
    expect(info.body.DeviceProfile.Name).toBe('FriendFlix Download');
  });

  it("'original' needs no preparation", async () => {
    const id = await jobs.create({ quality: 'original' });
    await enqueueJob(env.ctx, id);
    expect(requested).toEqual([]);
    expect((await jobs.get(id)).status).toBe('ready');
  });
});

describe('ffmpeg remux', () => {
  it('uses an args array with the fMP4 demuxer and a file-only protocol whitelist before -i', () => {
    const a = ffmpegArgs('/d/x.part', '/d/x.mp4.tmp');
    const i = a.indexOf('-i');
    expect(a.slice(0, i)).toEqual(['-nostdin', '-y', '-v', 'error', '-protocol_whitelist', 'file', '-f', 'mov']);
    expect(a.slice(i)).toEqual(['-i', '/d/x.part', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', '/d/x.mp4.tmp']);
  });

  const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  it.skipIf(!hasFfmpeg)('really remuxes a plain fragmented MP4 (init + fragments) and refuses non-file protocols', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ff-remux-'));
    const frag = join(d, 'frag.mp4');
    const gen = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10', '-t', '2', '-c:v', 'libx264', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', frag]);
    expect(gen.status, String(gen.stderr)).toBe(0);
    const out = join(d, 'out.mp4');
    await ffmpegRunner.remux(frag, out);
    expect(statSync(out).size).toBeGreaterThan(0);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv=p=0', out]);
    if (probe.status === 0) expect(String(probe.stdout)).toContain('mp4');
    await expect(ffmpegRunner.remux('http://127.0.0.1:9/x.mp4', join(d, 'no.mp4'))).rejects.toThrow();
    expect(existsSync(join(d, 'no.mp4'))).toBe(false);
  });
});

describe('gcDownloads', () => {
  const ready = async (bytes: number, lastUsedHoursAgo: number) => {
    const id = await jobs.create({ status: 'ready', bytes });
    writeFileSync(join(dir, `${id}.mp4`), 'x');
    await env.pool.query("update download_jobs set last_used_at = now() - make_interval(hours => $2) where id = $1", [id, lastUsedHoursAgo]);
    return id;
  };
  beforeEach(async () => {
    await env.pool.query('delete from download_jobs');
    for (const f of readdirSync(dir)) await import('node:fs/promises').then((m) => m.rm(join(dir, f), { force: true }));
  });

  it('removes ready files older than the TTL but keeps those with a pending license', async () => {
    const old = await ready(10, 100);
    const keep = await ready(10, 100);
    const fresh = await ready(10, 1);
    const user = (await env.pool.query('select id from users limit 1')).rows[0].id;
    const prof = (await env.pool.query('select id from profiles where user_id = $1 limit 1', [user])).rows[0].id;
    const dev = (await env.pool.query('select device_id from devices where user_id = $1 limit 1', [user])).rows[0].device_id;
    await env.pool.query("insert into downloads(id,user_id,device_id,profile_id,item_id,job_id,quality,status,expires_at) values ($1,$2,$3,$4,'it',$5,'hd','pending', now() + interval '1 day')", [randomUUID(), user, dev, prof, keep]);
    await gcDownloads(env.ctx);
    expect(existsSync(join(dir, `${old}.mp4`))).toBe(false);
    expect(await jobs.get(old)).toBeUndefined();
    expect(existsSync(join(dir, `${keep}.mp4`))).toBe(true);
    expect(existsSync(join(dir, `${fresh}.mp4`))).toBe(true);
    await env.pool.query("delete from downloads where job_id = $1", [keep]);
  });

  it('evicts least recently used files until under DOWNLOAD_CACHE_MAX_GB', async () => {
    const GB = 1024 ** 3;
    const a = await ready(Math.round(0.6 * GB), 5);
    const b = await ready(Math.round(0.6 * GB), 3);
    const c = await ready(Math.round(0.6 * GB), 1);
    const prev = env.ctx.cfg;
    env.ctx.cfg = { ...prev, DOWNLOAD_CACHE_MAX_GB: 1 };
    try {
      await gcDownloads(env.ctx);
    } finally {
      env.ctx.cfg = prev;
    }
    expect([a, b, c].map((id) => existsSync(join(dir, `${id}.mp4`)))).toEqual([false, false, true]);
  });

  it('drops orphan files, old crash leftovers, and jobs that lost all licenses', async () => {
    const orphan = join(dir, `${randomUUID()}.mp4`);
    writeFileSync(orphan, 'x');
    utimesSync(orphan, new Date(Date.now() - 7200_000), new Date(Date.now() - 7200_000));
    const recent = join(dir, `${randomUUID()}.mp4`);
    writeFileSync(recent, 'x'); // may belong to a job being created right now
    const lost = await jobs.create({ status: 'queued' });
    await env.pool.query("update download_jobs set updated_at = now() - interval '1 hour' where id = $1", [lost]);
    await gcDownloads(env.ctx);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(await jobs.get(lost)).toBeUndefined();
  });
});

describe('toDownloadSource', () => {
  const info = (over: Record<string, unknown> = {}, v: Record<string, unknown> = {}, a: Record<string, unknown> = {}) => ({
    PlaySessionId: 'ps',
    MediaSources: [{ Id: 'ms', Container: 'mp4', Bitrate: 4_000_000, Size: 2_000_000_000, RunTimeTicks: 36_000_000_000, ...over, MediaStreams: [
      { Type: 'Video', Index: 0, Codec: 'h264', Height: 720, BitDepth: 8, ...v },
      { Type: 'Audio', Index: 1, Codec: 'aac', Language: 'ger', IsDefault: true, ...a },
      { Type: 'Subtitle', Index: 2, Codec: 'subrip', Language: 'eng' },
      { Type: 'Subtitle', Index: 3, Codec: 'pgssub', Language: 'eng' },
    ] }],
  });
  const dto = (i: ReturnType<typeof info>, extra: Record<string, unknown> = {}) => toDownloadSource({ itemId: 'it', info: i, deviceId: 'd', quality: 'original', ...extra });
  it('original eligibility: mp4 + 8-bit h264 + aac within caps', () => {
    expect(dto(info()).originalEligible).toBe(true);
    expect(dto(info({ Container: 'mkv' })).originalEligible).toBe(false);
    expect(dto(info({}, { BitDepth: 10 })).originalEligible).toBe(false);
    expect(dto(info({}, { Codec: 'hevc' })).originalEligible).toBe(false);
    expect(dto(info({}, {}, { Codec: 'ac3' })).originalEligible).toBe(false);
    expect(dto(info(), { maxHeight: 480 }).originalEligible).toBe(false);
    expect(dto(info(), { maxBitrate: 3_000_000 }).originalEligible).toBe(false);
    expect(dto(info(), { maxHeight: 1080, maxBitrate: 8_000_000 }).originalEligible).toBe(true);
  });
  it('size, text subtitles and master path', () => {
    const o = dto(info());
    expect(o.sizeBytes).toBe(2_000_000_000);
    expect(o.masterPath).toBeUndefined();
    expect(o.subtitles).toEqual([{ index: 2, lang: 'eng', title: 'eng', url: '/media/Videos/it/ms/Subtitles/2/0/Stream.vtt' }]);
    const hd = toDownloadSource({ itemId: 'it', info: info(), deviceId: 'd', quality: 'hd', maxHeight: 720, maxBitrate: 2_628_000 });
    expect(hd.sizeBytes).toBe(Math.round((3600 * 2_628_000) / 8));
    expect(hd.masterPath).toMatch(/^\/Videos\/it\/master\.m3u8\?/);
  });
});

describe('role caps reach Jellyfin', () => {
  it('prepares with the job caps (max_height / max_bitrate), not the preset defaults', async () => {
    const id = await jobs.create({ quality: 'hd', max_height: 360, max_bitrate: 900_000 });
    await enqueueJob(env.ctx, id);
    const q = new URL(requested.find((x) => x.startsWith('master'))!.slice(6), 'http://x').searchParams;
    expect(q.get('MaxHeight')).toBe('360');
    expect(q.get('MaxStreamingBitrate')).toBe('900000');
    expect(Number(q.get('VideoBitrate'))).toBe(900_000 - 128_000);
    const info = env.jfCalls.filter((c) => c.path.endsWith('/PlaybackInfo')).at(-1)!;
    expect(info.search).toContain('MaxHeight=360');
    expect(info.search).toContain('MaxStreamingBitrate=900000');
  });
});

describe('disk guard', () => {
  const GB = 1024 ** 3;
  const withCfg = async (patch: Record<string, unknown>, fn: () => Promise<void>) => {
    const prev = env.ctx.cfg;
    env.ctx.cfg = { ...prev, ...patch };
    try { await fn(); } finally { env.ctx.cfg = prev; }
  };
  const logs: string[] = [];
  beforeEach(async () => {
    logs.length = 0;
    preparer(env.ctx).log = (m) => logs.push(m);
    await env.pool.query('delete from downloads');
    await env.pool.query('delete from download_jobs');
  });

  it('keeps a job queued (and logs once) while ready + partial + estimate exceed DOWNLOAD_CACHE_MAX_GB, then runs when it fits', async () => {
    const id = await jobs.create();
    await jobs.holder(id, { runtimeMin: 90 }); // hd: ~1.8 GB, x2 while remuxing
    await withCfg({ DOWNLOAD_CACHE_MAX_GB: 2 }, async () => {
      await enqueueJob(env.ctx, id);
      await enqueueJob(env.ctx, id);
    });
    expect((await jobs.get(id)).status).toBe('queued');
    expect(requested).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('cache cap');
    await enqueueJob(env.ctx, id);
    expect((await jobs.get(id)).status).toBe('ready');
  });

  it('counts .part files of other jobs', async () => {
    const other = await jobs.create({ status: 'preparing' });
    writeFileSync(join(dir, `${other}.part`), Buffer.alloc(1024));
    const id = await jobs.create();
    await jobs.holder(id, { runtimeMin: 1 }); // ~20 MB, x2
    const tiny = (2 * 19_710_000 + 1024 - 1) / GB; // hd: 328 500 B/s x 60 s, x2; cap one byte below parts + need
    await withCfg({ DOWNLOAD_CACHE_MAX_GB: tiny }, async () => { await enqueueJob(env.ctx, id); });
    expect((await jobs.get(id)).status).toBe('queued');
    await withCfg({ DOWNLOAD_CACHE_MAX_GB: 1 }, async () => { await enqueueJob(env.ctx, id); });
    expect((await jobs.get(id)).status).toBe('ready');
    await import('node:fs/promises').then((m) => m.rm(join(dir, `${other}.part`), { force: true }));
  });

  it('keeps a job queued while the volume would drop below DOWNLOAD_MIN_FREE_GB', async () => {
    const p = preparer(env.ctx);
    const orig = p.freeBytes;
    p.freeBytes = async () => 3 * GB; // need ~3.6 GB (2 x 1.8) -> below the margin
    const id = await jobs.create();
    await jobs.holder(id, { runtimeMin: 90 });
    try {
      await withCfg({ DOWNLOAD_MIN_FREE_GB: 2 }, async () => { await enqueueJob(env.ctx, id); });
      expect((await jobs.get(id)).status).toBe('queued');
      expect(requested).toEqual([]);
      expect(logs[0]).toContain('low disk space');
      p.freeBytes = async () => 100 * GB;
      await withCfg({ DOWNLOAD_MIN_FREE_GB: 2 }, async () => { await enqueueJob(env.ctx, id); });
      expect((await jobs.get(id)).status).toBe('ready');
    } finally {
      p.freeBytes = orig;
    }
  });

  it('evicts unprotected ready files (LRU) to make room before giving up', async () => {
    const old = await jobs.create({ status: 'ready', bytes: Math.round(1.5 * GB) });
    writeFileSync(join(dir, `${old}.mp4`), 'x');
    await env.pool.query("update download_jobs set last_used_at = now() - interval '1 hour' where id = $1", [old]);
    const prot = await jobs.create({ status: 'ready', bytes: Math.round(0.4 * GB) });
    writeFileSync(join(dir, `${prot}.mp4`), 'x');
    await jobs.holder(prot);
    const id = await jobs.create();
    await jobs.holder(id, { runtimeMin: 90 }); // needs ~3.6 GB
    await withCfg({ DOWNLOAD_CACHE_MAX_GB: 5 }, async () => { await enqueueJob(env.ctx, id); });
    expect(await jobs.get(old)).toBeUndefined();
    expect(existsSync(join(dir, `${old}.mp4`))).toBe(false);
    expect((await jobs.get(prot)).status).toBe('ready'); // pending license: protected
    expect((await jobs.get(id)).status).toBe('ready');
  });
});

describe('pending licenses lose eviction protection after 3 days', () => {
  beforeEach(async () => {
    await env.pool.query('delete from downloads');
    await env.pool.query('delete from download_jobs');
  });
  it('ttl and cap eviction honour only fresh pending licenses', async () => {
    const mk = async (ageDays: number) => {
      const id = await jobs.create({ status: 'ready', bytes: 10 });
      writeFileSync(join(dir, `${id}.mp4`), 'x');
      await env.pool.query("update download_jobs set last_used_at = now() - interval '10 days' where id = $1", [id]);
      await jobs.holder(id, { ageDays });
      return id;
    };
    const fresh = await mk(2), stale = await mk(4);
    await gcDownloads(env.ctx);
    expect(await jobs.get(fresh)).toBeDefined();
    expect(existsSync(join(dir, `${fresh}.mp4`))).toBe(true);
    expect(await jobs.get(stale)).toBeUndefined();
    expect(existsSync(join(dir, `${stale}.mp4`))).toBe(false);
    // the license of the dropped job survives and shows a failed preparation
    expect((await env.pool.query("select count(*) n from downloads where job_id is null and status = 'pending'")).rows[0].n).toBe('1');
  });
});

describe('cancel', () => {
  beforeEach(async () => {
    await env.pool.query('delete from downloads');
    await env.pool.query('delete from download_jobs');
  });
  const lic = async (jobId: string) => {
    const hid = await jobs.holder(jobId);
    const r = (await env.pool.query('select user_id, device_id, profile_id from downloads where id = $1', [hid])).rows[0];
    return { hid, cancel: () => deleteLicense(env.ctx, r.user_id, r.device_id, r.profile_id, hid) };
  };

  it('removes a waiting job from the queue (its enqueue settles, nothing is fetched)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = preparer(env.ctx);
    const orig = p.runner;
    p.runner = { remux: async (i, o) => { await gate; await copyFile(i, o); } };
    try {
      const first = await jobs.create();
      const second = await jobs.create();
      const h2 = await lic(second);
      const e1 = enqueueJob(env.ctx, first);
      for (let i = 0; i < 400 && !requested.some((x) => x === `seg${SEGS - 1}`); i++) await new Promise((r) => setTimeout(r, 5)); // first is at the remux gate
      requested = [];
      const e2 = enqueueJob(env.ctx, second);
      expect(p.isRunning(second)).toBe(true);
      await h2.cancel();
      await e2; // settles although it never got a slot
      expect(await jobs.get(second)).toMatchObject({ status: 'failed', error: 'cancelled' });
      release();
      await e1;
      expect(requested).toEqual([]); // second never pulled anything
      expect((await jobs.get(first)).status).toBe('ready');
      expect(p.isRunning(second)).toBe(false);
    } finally {
      release();
      p.runner = orig;
    }
  });

  it('stops a paused running job when the last holder is gone: transcode stopped, .part removed', async () => {
    const pv = previews(env.ctx);
    pv.paused = true;
    const id = await jobs.create();
    const h = await lic(id);
    const done = enqueueJob(env.ctx, id);
    const p = preparer(env.ctx);
    for (let i = 0; i < 200 && !p.pausedJobs.has(id); i++) await new Promise((r) => setTimeout(r, 5));
    expect(existsSync(join(dir, `${id}.part`))).toBe(true);
    await h.cancel();
    await done;
    pv.paused = false;
    expect(await jobs.get(id)).toMatchObject({ status: 'failed', error: 'cancelled' });
    expect(existsSync(join(dir, `${id}.part`))).toBe(false);
    expect(existsSync(join(dir, `${id}.mp4`))).toBe(false);
    expect(env.jfCalls.filter((c) => c.method === 'DELETE' && c.path === '/Videos/ActiveEncodings').length).toBeGreaterThan(1); // on pause and in the finally
  });

  it('stops at the next segment when cancelled while downloading, cleaning up .part', async () => {
    const id = await jobs.create();
    const h = await lic(id);
    const p = preparer(env.ctx);
    const origSleep = p.sleep;
    let first = true;
    badSeg = 3;
    // the first failed fetch of segment 3 sleeps before the retry: cancel in that window (deterministic)
    p.sleep = async () => {
      if (first) { first = false; badSeg = -99; await h.cancel(); }
    };
    try {
      await enqueueJob(env.ctx, id);
    } finally {
      p.sleep = origSleep;
    }
    expect(await jobs.get(id)).toMatchObject({ status: 'failed', error: 'cancelled' });
    expect(requested.filter((x) => x.startsWith('seg'))).toEqual(['seg-1', 'seg0', 'seg1', 'seg2', 'seg3', 'seg3']); // stopped right after the segment that was in flight
    expect(existsSync(join(dir, `${id}.part`))).toBe(false);
    expect(remuxed).toHaveLength(0);
    expect(env.jfCalls.some((c) => c.method === 'DELETE' && c.path === '/Videos/ActiveEncodings')).toBe(true);
  });
});

describe('POST /api/downloads does not wait for preparation', () => {
  it('returns while the real preparer is still busy with a slow runner, then the job completes', async () => {
    await env.pool.query('delete from downloads');
    await env.pool.query('delete from download_jobs');
    const admin = await env.login();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let remuxStarted = false;
    const p = preparer(env.ctx);
    const orig = p.runner;
    p.runner = { remux: async (i, o) => { remuxStarted = true; await gate; await copyFile(i, o); } };
    const prev = env.ctx.cfg;
    env.ctx.cfg = { ...prev, BACKGROUND_JOBS: 'true' };
    try {
      const res = await env.app.inject({ method: 'POST', url: '/api/downloads', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { itemId: MOVIE, quality: 'hd' } });
      expect(res.statusCode).toBe(200);
      const job = (await env.pool.query('select * from download_jobs')).rows[0];
      expect(res.json().licenses[0]).toMatchObject({ ready: false });
      // the response is out although the preparation has not finished (it is stuck at the remux gate or still starting)
      expect((await jobs.get(job.id)).status).not.toBe('ready');
      expect(p.isRunning(job.id)).toBe(true);
      for (let i = 0; i < 400 && !remuxStarted; i++) await new Promise((r) => setTimeout(r, 5));
      expect(remuxStarted).toBe(true);
      release();
      await p.whenIdle();
      expect((await jobs.get(job.id)).status).toBe('ready');
    } finally {
      release();
      env.ctx.cfg = prev;
      p.runner = orig;
    }
  });
});

// last: it builds its own env, which resets the shared database
describe('setUserData', () => {
  it('uses /UserItems and falls back to the legacy path on 404', async () => {
    const e2 = await makeEnv({
      'POST /UserItems/[^/]+/UserData': () => ({ status: 404 }),
      'POST /Users/[^/]+/Items/[^/]+/UserData': () => ({ status: 204 }),
    });
    try {
      const user = (await e2.pool.query("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 's', 's@x.de', 'S', 'family', $1, 's', $2) returning *", ['2'.repeat(32), (await import('../src/crypto.js')).encrypt((await import('../src/crypto.js')).keyFromBase64((await import('./helpers.js')).ENC_KEY), 'pw')])).rows[0];
      await e2.ctx.jf.setUserData(user, 'item1', { positionTicks: 123.4, played: true, lastPlayedDate: new Date('2026-01-02T03:04:05Z') });
      const paths = e2.jfCalls.filter((c) => c.path.endsWith('/UserData')).map((c) => c.path);
      expect(paths).toEqual(['/UserItems/item1/UserData', `/Users/${'2'.repeat(32)}/Items/item1/UserData`]);
      expect(e2.jfCalls.filter((c) => c.path.endsWith('/UserData')).at(-1)!.body).toEqual({ PlaybackPositionTicks: 123, Played: true, LastPlayedDate: '2026-01-02T03:04:05.000Z' });
    } finally {
      await e2.close();
    }
  });
});
