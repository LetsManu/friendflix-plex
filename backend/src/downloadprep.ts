import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, rename, rm, stat, statfs, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ctx } from './ctx.js';
import { DOWNLOAD_PRESETS, type DownloadQuality } from './jellyfin/dto.js';
import { listLive } from './live.js';
import { m, type Text } from './i18n.js';
import { notify } from './notify.js';
import { previews, serviceUser } from './previews.js';
import { getProfile, jfUserFor } from './profiles.js';
import type { JfUser, UserRow } from './types.js';

export { DOWNLOAD_PRESETS };
export type { DownloadQuality };

export interface JobRow {
  id: string;
  item_id: string;
  quality: DownloadQuality;
  audio_lang: string;
  /** effective caps this file is prepared with (0 = preset defaults) */
  max_height: number;
  max_bitrate: number;
  media_source_id: string | null;
  status: 'queued' | 'preparing' | 'ready' | 'failed';
  seg_done: number;
  seg_total: number | null;
  init_sha: string | null;
  bytes: string | number | null;
  error: string | null;
  play_session_id: string | null;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date;
}

/** Progress shown as "Wird vorbereitet · 34 %": segments fetched; 99 until the remux finished, 100 when ready. */
export function jobProgress(job: Pick<JobRow, 'status' | 'seg_done' | 'seg_total'>): number {
  if (job.status === 'ready') return 100;
  if (!job.seg_total || job.seg_total <= 0) return 0;
  return Math.max(0, Math.min(99, Math.floor((job.seg_done / job.seg_total) * 100)));
}

export const downloadFile = (ctx: Pick<Ctx, 'cfg'>, jobId: string) => join(ctx.cfg.DOWNLOAD_DIR, `${jobId}.mp4`);
const partFile = (ctx: Pick<Ctx, 'cfg'>, jobId: string) => join(ctx.cfg.DOWNLOAD_DIR, `${jobId}.part`);

/** Remux step behind an interface so tests need no ffmpeg binary. */
export interface FfmpegRunner {
  /** Stream-copies `input` (concatenated fMP4: init + segments) into a faststart MP4 at `output`. */
  remux(input: string, output: string): Promise<void>;
}

/**
 * Input options (must precede -i). The part file is plain fragmented MP4 (init segment + moof/mdat fragments), so the mov/mp4 demuxer is
 * forced (no probing of arbitrary formats) and only the `file` protocol may be opened (no network/concat/subfile tricks). Args array, no shell.
 */
export const FFMPEG_INPUT_ARGS = ['-protocol_whitelist', 'file', '-f', 'mov'] as const;

/** Full ffmpeg argument list (array, never a shell). */
export const ffmpegArgs = (input: string, output: string): string[] =>
  ['-nostdin', '-y', '-v', 'error', ...FFMPEG_INPUT_ARGS, '-i', input, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', output];

export const ffmpegRunner: FfmpegRunner = {
  remux(input, output) {
    return new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', ffmpegArgs(input, output), { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-500); });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.trim()}`))));
    });
  },
};

class Cancelled extends Error {}

const resolveUri = (base: string, uri: string): string => {
  const u = new URL(uri, new URL(base, 'http://jf.invalid'));
  return u.pathname + u.search;
};
const lines = (p: string) => p.split(/\r?\n/).map((l) => l.trim());
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

const cfgNum = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

class Preparer {
  runner: FfmpegRunner = ffmpegRunner;
  /** Delay between pause re-checks / segment retries; tests shrink it. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
  pollMs = 15_000;
  retryMs = 2_000;
  private readonly inflight = new Map<string, Promise<void>>();
  private running = 0;
  private readonly waiting: Array<{ jobId: string; grant: () => void; drop: () => void }> = [];
  /** Test hook: free bytes on the download volume. */
  freeBytes: (dir: string) => Promise<number> = async (dir) => { const s = await statfs(dir); return Number(s.bavail) * Number(s.bsize); };
  /** Test hook / log sink for "stays queued" notes. */
  log: (msg: string) => void = (msg) => console.warn(msg);
  private readonly blocked = new Set<string>();
  /** Jobs whose Jellyfin transcode is currently stopped because of a pause (observable for tests). */
  pausedJobs = new Set<string>();

  constructor(private readonly ctx: Ctx) {}

  isRunning(jobId: string) { return this.inflight.has(jobId); }
  get idle() { return this.inflight.size === 0; }
  whenIdle() { return Promise.allSettled([...this.inflight.values()]).then(() => undefined); }

  /** Queues a job (single-flight per job id); the returned promise settles when preparation finished or failed. */
  enqueue(jobId: string): Promise<void> {
    const cur = this.inflight.get(jobId);
    if (cur) return cur;
    const p = this.slot(jobId).then(async (release) => {
      try { await this.run(jobId); } finally { release(); }
    }).catch((e) => { if (!(e instanceof Cancelled)) throw e; }); // cancelled while waiting for a slot
    const done = p.catch(() => undefined);
    this.inflight.set(jobId, p);
    void done.then(() => { this.inflight.delete(jobId); this.updateBusy(); });
    this.updateBusy();
    return p;
  }

  private updateBusy() { previews(this.ctx).downloadBusy = this.running > 0; }

  private slot(jobId: string): Promise<() => void> {
    const max = Math.max(1, cfgNum(this.ctx.cfg.DOWNLOAD_PREP_CONCURRENCY, 1));
    const release = () => {
      this.running--;
      this.waiting.shift()?.grant();
    };
    if (this.running < max) { this.running++; return Promise.resolve(release); }
    return new Promise((res, rej) => this.waiting.push({ jobId, grant: () => { this.running++; res(release); }, drop: () => rej(new Cancelled()) }));
  }

  /** Removes a job from the waiting queue (its enqueue promise settles). A running job notices the cancellation at its next segment. */
  cancel(jobId: string) {
    const i = this.waiting.findIndex((w) => w.jobId === jobId);
    if (i >= 0) this.waiting.splice(i, 1)[0]!.drop();
    this.blocked.delete(jobId);
  }

  /** Picks up queued/preparing jobs (also after a restart). */
  async tick(): Promise<void> {
    if (this.ctx.cfg.DOWNLOADS_ENABLED === 'false') return;
    const rows = (await this.ctx.db.query<{ id: string }>("select id from download_jobs where status in ('queued','preparing') order by created_at")).rows;
    for (const r of rows) if (!this.inflight.has(r.id)) void this.enqueue(r.id).catch(() => undefined);
  }

  /** Who pulls the segments: the Jellyfin identity (user + profile) of the oldest pending license holder (parental access was checked for them), else the admin service user. */
  private async pullUser(jobId: string): Promise<JfUser | undefined> {
    const r = await this.ctx.db.query<{ user_id: string; profile_id: string }>(
      `select d.user_id, d.profile_id from downloads d join users u on u.id = d.user_id
        where d.job_id = $1 and d.status = 'pending' and not u.disabled order by d.created_at limit 1`,
      [jobId],
    );
    const h = r.rows[0];
    if (h) {
      const user = (await this.ctx.db.query<UserRow>('select * from users where id = $1', [h.user_id])).rows[0];
      const profile = user ? await getProfile(this.ctx, h.user_id, h.profile_id) : null;
      if (user && profile) return jfUserFor(user, profile);
      if (user) return user;
    }
    return serviceUser(this.ctx);
  }

  private async shouldPause(): Promise<boolean> {
    if (previews(this.ctx).paused) return true; // nightly playback check
    const limit = cfgNum(this.ctx.cfg.DOWNLOAD_PAUSE_STREAMS, 2);
    if (limit <= 0) return false;
    return (await listLive(this.ctx).catch(() => [])).length >= limit;
  }

  private async run(jobId: string): Promise<void> {
    const { ctx } = this;
    const job = (await ctx.db.query<JobRow>('select * from download_jobs where id = $1', [jobId])).rows[0];
    if (!job || (job.status !== 'queued' && job.status !== 'preparing')) return;
    try {
      await mkdir(ctx.cfg.DOWNLOAD_DIR, { recursive: true });
      if (job.quality === 'original') {
        // served as is by the gateway: nothing to prepare
        await ctx.db.query("update download_jobs set status = 'ready', error = null, updated_at = now() where id = $1", [jobId]);
        return;
      }
      const user = await this.pullUser(jobId);
      if (!user) return; // nobody to pull as yet: retried by the next tick
      if (!(await this.hasRoom(job))) return; // stays queued: retried by the next tick
      this.blocked.delete(jobId);
      const go = await ctx.db.query("update download_jobs set status = 'preparing', error = null, updated_at = now() where id = $1 and status in ('queued','preparing')", [jobId]);
      if (!go.rowCount) return; // cancelled in the meantime
      await this.prepare(user, job);
    } catch (e) {
      if (e instanceof Cancelled) {
        await rm(partFile(ctx, jobId), { force: true });
        return;
      }
      console.warn(`download job ${jobId} failed: ${errMsg(e)}`); // the raw error is for logs + admin overview only; users see a generic text
      await ctx.db.query("update download_jobs set status = 'failed', error = $2, updated_at = now() where id = $1", [jobId, errMsg(e)]);
      await rm(partFile(ctx, jobId), { force: true }).catch(() => undefined);
    }
  }

  private async fetchOk(user: JfUser, path: string): Promise<Response> {
    const res = await this.ctx.jf.call(user, path);
    if (!res.ok) throw new Error(`Jellyfin ${path.split('?')[0]} -> ${res.status}`);
    return res;
  }

  /** Segment with a few retries: Jellyfin answers 5xx while a restarted transcode spins up. */
  private async fetchBytes(user: JfUser, path: string): Promise<Buffer> {
    let last: unknown;
    for (let n = 0; n < 4; n++) {
      try {
        return Buffer.from(await (await this.fetchOk(user, path)).arrayBuffer());
      } catch (e) {
        last = e;
        await this.sleep(this.retryMs * (n + 1));
      }
    }
    throw last;
  }

  /** Still wanted: not cancelled / removed and somebody (a pending license) is waiting for it. */
  private async alive(jobId: string): Promise<boolean> {
    return ((await this.ctx.db.query(
      "select 1 from download_jobs j where j.id = $1 and j.status in ('queued','preparing') and exists (select 1 from downloads d where d.job_id = j.id and d.status = 'pending')",
      [jobId],
    )).rowCount ?? 0) > 0;
  }

  private async partBytes(skip?: string): Promise<{ total: number; own: number }> {
    let total = 0, own = 0;
    for (const f of await readdir(this.ctx.cfg.DOWNLOAD_DIR).catch(() => [] as string[])) {
      if (!f.endsWith('.part')) continue;
      const size = (await stat(join(this.ctx.cfg.DOWNLOAD_DIR, f)).catch(() => undefined))?.size ?? 0;
      total += size;
      if (skip && f === `${skip}.part`) own = size;
    }
    return { total, own };
  }

  /** Estimated size of the finished file (bitrate x runtime of the license holders' item). */
  private async estimate(job: JobRow): Promise<number> {
    const preset = DOWNLOAD_PRESETS[job.quality as Exclude<DownloadQuality, 'original'>];
    const bps = job.max_bitrate || (preset ? preset.videoBps + preset.audioBps : 5_000_000);
    const t = (await this.ctx.db.query<{ t: string | null }>("select max((meta->>'runtimeTicks')::numeric)::text t from downloads where job_id = $1", [job.id])).rows[0]?.t;
    const secs = t ? Number(t) / 1e7 : job.seg_total ? job.seg_total * 6 : 7200;
    return Math.ceil((bps / 8) * secs);
  }

  /**
   * Disk guard before a job starts/resumes: ready files + partial files + this job (the .part and the remuxed copy exist side by side)
   * must fit DOWNLOAD_CACHE_MAX_GB, and the volume must keep DOWNLOAD_MIN_FREE_GB free. Tries to evict unprotected ready files first.
   */
  private async hasRoom(job: JobRow): Promise<boolean> {
    const { ctx } = this;
    const cap = cfgNum(ctx.cfg.DOWNLOAD_CACHE_MAX_GB, 50) * 1024 ** 3;
    const minFree = cfgNum(ctx.cfg.DOWNLOAD_MIN_FREE_GB, 2) * 1024 ** 3;
    const est = await this.estimate(job);
    const verdict = async () => {
      const parts = await this.partBytes(job.id);
      const need = Math.max(0, 2 * est - parts.own);
      const ready = Number((await ctx.db.query<{ n: string }>("select coalesce(sum(bytes),0)::text n from download_jobs where status = 'ready' and quality <> 'original'")).rows[0]!.n);
      const free = await this.freeBytes(ctx.cfg.DOWNLOAD_DIR).catch(() => Infinity);
      return { reserve: parts.total + need, overCap: ready + parts.total + need > cap, lowSpace: free - need < minFree, ready, free, need };
    };
    let v = await verdict();
    if (v.overCap || v.lowSpace) {
      await gcDownloads(ctx, Date.now(), v.reserve).catch(() => 0); // evicts least recently used files nobody waits for
      v = await verdict();
    }
    if (!v.overCap && !v.lowSpace) return true;
    if (!this.blocked.has(job.id)) {
      this.blocked.add(job.id);
      this.log(`download job ${job.id} stays queued: ${v.overCap ? 'cache cap reached' : 'low disk space'} (ready ${v.ready} B, needs ~${v.need} B, free ${v.free} B)`);
    }
    return false;
  }

  private async prepare(user: JfUser, job: JobRow): Promise<void> {
    const { ctx } = this;
    const preset = DOWNLOAD_PRESETS[job.quality as Exclude<DownloadQuality, 'original'>];
    if (!preset) throw new Error(`unknown quality ${job.quality}`);
    // the caps the user was shown (role clamp); 0 = preset default
    const maxHeight = job.max_height || preset.height;
    const maxBitrate = job.max_bitrate || preset.videoBps + preset.audioBps;
    const part = partFile(ctx, job.id);

    // audio track by language (empty = the file's default)
    let audioIndex: number | undefined;
    if (job.audio_lang) {
      const probe = await ctx.jf.downloadSource(user, job.item_id, { quality: job.quality, maxHeight, maxBitrate });
      audioIndex = probe.audio.find((a) => a.lang.toLowerCase() === job.audio_lang.toLowerCase())?.index;
    }
    const src = await ctx.jf.downloadSource(user, job.item_id, { quality: job.quality, audioIndex, maxHeight, maxBitrate });
    if (!src.masterPath) throw new Error('no master playlist');
    const q = new URL(src.masterPath, 'http://jf.invalid').searchParams;
    const playSessionId = q.get('PlaySessionId') ?? src.playSessionId;
    try {
      const variant = lines(await (await this.fetchOk(user, src.masterPath)).text()).find((l) => l && !l.startsWith('#'));
      if (!variant) throw new Error('no variant');
      const mediaPath = resolveUri(src.masterPath, variant);
      const media = lines(await (await this.fetchOk(user, mediaPath)).text());
      const map = media.find((l) => l.startsWith('#EXT-X-MAP:'))?.match(/URI="([^"]+)"/)?.[1];
      const segs = media.filter((l) => l && !l.startsWith('#'));
      if (!map || !segs.length) throw new Error('empty playlist');

      // resume only if the init segment is byte-identical and our partial file is intact
      const init = await this.fetchBytes(user, resolveUri(mediaPath, map));
      const sha = createHash('sha256').update(init).digest('hex');
      let done = job.seg_done;
      const have = await stat(part).then((s) => s.size, () => -1);
      const expected = Number(job.bytes ?? 0);
      if (done > 0 && (job.init_sha !== sha || job.seg_total !== segs.length || have < expected || expected <= 0 || done > segs.length)) done = 0;
      if (done === 0) {
        await writeFile(part, init);
      } else {
        await truncate(part, expected); // drop a segment that was half written when we died
      }
      let bytes = done === 0 ? init.length : expected;
      await ctx.db.query('update download_jobs set init_sha = $2, seg_total = $3, seg_done = $4, bytes = $5, media_source_id = $6, play_session_id = $7, updated_at = now() where id = $1', [job.id, sha, segs.length, done, bytes, src.mediaSourceId, playSessionId]);

      let stopped = false;
      for (let n = done; n < segs.length; n++) {
        while (await this.shouldPause()) {
          if (!stopped) {
            stopped = true;
            this.pausedJobs.add(job.id);
            await ctx.jf.stopEncoding(user, playSessionId);
          }
          await this.sleep(this.pollMs);
          if (!(await this.alive(job.id))) throw new Cancelled();
        }
        stopped = false;
        this.pausedJobs.delete(job.id);
        const seg = await this.fetchBytes(user, resolveUri(mediaPath, segs[n]!));
        await appendFile(part, seg);
        bytes += seg.length;
        const upd = await ctx.db.query("update download_jobs set seg_done = $2, bytes = $3, updated_at = now() where id = $1 and status in ('queued','preparing')", [job.id, n + 1, bytes]);
        if (!upd.rowCount) throw new Cancelled(); // license holders cancelled / GC removed the job
      }

      const file = downloadFile(ctx, job.id);
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        await this.runner.remux(part, tmp);
        const size = (await stat(tmp)).size;
        if (!size) throw new Error('empty remux output');
        await rename(tmp, file);
        await rm(part, { force: true });
        const ok = await ctx.db.query("update download_jobs set status = 'ready', bytes = $2, error = null, updated_at = now(), last_used_at = now() where id = $1 and status = 'preparing'", [job.id, size]);
        if (!ok.rowCount) { await rm(file, { force: true }); throw new Cancelled(); }
      } finally {
        await rm(tmp, { force: true }).catch(() => undefined);
      }
      await this.notifyReady(user, job);
    } finally {
      this.pausedJobs.delete(job.id);
      await ctx.jf.stopEncoding(user, playSessionId); // always: Jellyfin keeps the transcode (and its temp files) alive otherwise
    }
  }

  private async notifyReady(user: JfUser, job: JobRow): Promise<void> {
    const { ctx } = this;
    const name = await ctx.jf.item(user, job.item_id).then((i): Text => i.name, (): Text => m('download.yourTitle'));
    const holders = (await ctx.db.query<{ user_id: string }>("select distinct user_id from downloads where job_id = $1 and status = 'pending'", [job.id])).rows;
    for (const h of holders) {
      await notify(ctx, { userId: h.user_id, kind: 'download_ready', title: m('download.ready.title'), body: m('download.ready.body', { title: name }), link: '/downloads', dedupe: `download-ready-${job.id}-${h.user_id}` }).catch(() => false);
    }
  }
}

/**
 * A pending license (file prepared, device has not fetched it yet) protects its job from eviction for this long. After that the license is
 * considered abandoned: it stays 'pending' (the device may still fetch if the file survives) but no longer pins the file; if the file is gone
 * the license shows a failed preparation and the user can delete it / request it again.
 */
export const PENDING_PROTECT_DAYS = 3;

/** Disk cap + TTL + orphan cleanup. `reserve` = bytes the caller is about to need (counted against the cap). Returns the number of removed files. */
export async function gcDownloads(ctx: Ctx, now = Date.now(), reserve = 0): Promise<number> {
  const dir = ctx.cfg.DOWNLOAD_DIR;
  let removed = 0;
  const protectAfter = new Date(now - PENDING_PROTECT_DAYS * 86_400_000);
  const drop = async (id: string) => {
    // never drop a job a fresh pending license points to (license creation races with gc)
    const del = await ctx.db.query(
      "delete from download_jobs j where j.id = $1 and not exists (select 1 from downloads d where d.job_id = j.id and d.status = 'pending' and d.created_at > $2)",
      [id, protectAfter],
    );
    if (!del.rowCount) return;
    await rm(downloadFile(ctx, id), { force: true });
    await rm(partFile(ctx, id), { force: true });
    removed++;
  };
  const ttlMs = cfgNum(ctx.cfg.DOWNLOAD_FILE_TTL_HOURS, 48) * 3600_000;
  const pendingOf = async () => new Set((await ctx.db.query<{ job_id: string }>("select distinct job_id from downloads where status = 'pending' and job_id is not null and created_at > $1", [protectAfter])).rows.map((r) => r.job_id));

  // 1. TTL: ready files nobody is waiting for and nobody touched for a while
  const pending = await pendingOf();
  const ready = (await ctx.db.query<JobRow>("select * from download_jobs where status = 'ready' and quality <> 'original' order by last_used_at")).rows;
  const live: JobRow[] = [];
  for (const j of ready) {
    if (!pending.has(j.id) && now - j.last_used_at.getTime() > ttlMs) await drop(j.id);
    else live.push(j);
  }
  // 2. cap: least recently used first, never a file with a pending license
  const cap = cfgNum(ctx.cfg.DOWNLOAD_CACHE_MAX_GB, 50) * 1024 ** 3;
  let total = live.reduce((a, j) => a + Number(j.bytes ?? 0), 0) + reserve;
  for (const j of live) {
    if (total <= cap) break;
    if (pending.has(j.id)) continue;
    total -= Number(j.bytes ?? 0);
    await drop(j.id);
  }
  // 3. jobs that lost every license (cancelled while queued / preparing), failed jobs after a week
  const grace = new Date(now - 10 * 60_000);
  const stale = await ctx.db.query<{ id: string }>(
    `select j.id from download_jobs j where j.quality <> 'original' and (
       (j.status in ('queued','preparing') and j.updated_at < $1 and not exists (select 1 from downloads d where d.job_id = j.id and d.status = 'pending' and d.created_at > $3))
       or (j.status = 'failed' and (j.updated_at < $2 or (j.error = 'cancelled' and j.updated_at < $1))))`,
    [grace, new Date(now - 7 * 24 * 3600_000), protectAfter],
  );
  for (const r of stale.rows) {
    if (!preparer(ctx).isRunning(r.id)) await drop(r.id);
  }
  // 4. files without a job row, leftovers of crashed remuxes
  const known = new Set((await ctx.db.query<{ id: string }>('select id from download_jobs')).rows.map((r) => r.id));
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    const id = f.slice(0, 36);
    const full = join(dir, f);
    const isTmp = /\.tmp$/.test(f);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\./.test(f)) continue;
    if (known.has(id) && !isTmp) continue;
    const age = now - ((await stat(full).catch(() => undefined))?.mtimeMs ?? now);
    if (age > 3600_000) { await rm(full, { force: true }); removed++; }
  }
  return removed;
}

const instances = new WeakMap<Ctx, Preparer>();
export function preparer(ctx: Ctx): Preparer {
  let p = instances.get(ctx);
  if (!p) instances.set(ctx, (p = new Preparer(ctx)));
  return p;
}

/** Queues preparation of a download job (idempotent; resumes from seg_done). */
export function enqueueJob(ctx: Ctx, jobId: string): Promise<void> {
  return preparer(ctx).enqueue(jobId);
}

export function startPreparerTick(ctx: Ctx): Promise<void> {
  return preparer(ctx).tick();
}
