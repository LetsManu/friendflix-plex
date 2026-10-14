// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Ctx } from './ctx.js';
import { MediaError, type ItemDto } from './media/types.js';
import { enqueueJob, jobProgress, preparer } from './downloadprep.js';
import { getProfile, jfUserFor } from './profiles.js';
import { effectiveRole, type RoleTemplate } from './roles.js';
import type { Session } from './session.js';
import type { JfUser, UserRow } from './types.js';

export type Quality = 'sd' | 'hd' | 'fhd' | 'original';
export const QUALITIES: readonly Quality[] = ['sd', 'hd', 'fhd', 'original'];

/** What ctx.jf.downloadSource() reports about an item (see media/types.ts). */
export interface DownloadSourceInfo {
  mediaSourceId: string;
  originalEligible: boolean;
  sizeBytes?: number | null;
  runtimeTicks?: number | null;
  audio: Array<{ index: number; lang: string; title: string }>;
  subtitles: Array<{ index: number; lang: string; title: string; url: string }>;
}

export interface QualityOption {
  id: Quality;
  label: string;
  /** target height in px (null = source as is) */
  height: number | null;
  /** video + audio bits per second (null = source) */
  videoBitrate: number | null;
  audioBitrate: number | null;
  estBytes: number;
}

interface Preset { id: Exclude<Quality, 'original'>; label: string; height: number; video: number; audio: number }
export const PRESETS: Preset[] = [
  { id: 'sd', label: 'Niedrig (480p)', height: 480, video: 1_000_000, audio: 128_000 },
  { id: 'hd', label: 'Standard (720p)', height: 720, video: 2_500_000, audio: 128_000 },
  { id: 'fhd', label: 'Hoch (1080p)', height: 1080, video: 5_000_000, audio: 160_000 },
];

export type DownloadRole = Pick<RoleTemplate, 'download' | 'maxDownloads' | 'downloadMaxHeight' | 'downloadDays' | 'maxHeight' | 'maxBitrate'>;

export const downloadsEnabled = (ctx: Pick<Ctx, 'cfg'>) => ctx.cfg.DOWNLOADS_ENABLED === 'true';

/** Role allows offline copies at all (and the feature is switched on). */
export const roleAllowsDownloads = (ctx: Pick<Ctx, 'cfg'>, role: DownloadRole | undefined): role is DownloadRole =>
  Boolean(role && downloadsEnabled(ctx) && role.download && role.maxDownloads > 0 && role.downloadMaxHeight > 0);

/** Height cap for downloads: min(role.maxHeight, role.downloadMaxHeight). */
export const downloadHeightCap = (role: DownloadRole) => Math.min(role.maxHeight ?? Infinity, role.downloadMaxHeight || 0);

export function estimateBytes(videoBitrate: number, audioBitrate: number, runtimeTicks: number | null | undefined): number {
  const secs = (runtimeTicks ?? 0) / 1e7;
  return Math.round(((videoBitrate + audioBitrate) / 8) * secs);
}

/** Qualities a role may pick for a source. Presets are clamped to the role's height and bitrate caps; `original` only when the source qualifies. */
export function qualityOptions(role: DownloadRole, src: Pick<DownloadSourceInfo, 'originalEligible' | 'sizeBytes' | 'runtimeTicks'>): QualityOption[] {
  const cap = downloadHeightCap(role);
  if (!(cap > 0)) return [];
  const out: QualityOption[] = [];
  for (const p of PRESETS) {
    // sd is always offered (clamped down for tiny caps); hd/fhd only when the role's cap reaches them
    if (p.id !== 'sd' && cap < p.height) continue;
    const height = Math.min(p.height, cap);
    const audio = p.audio;
    const video = Math.max(100_000, Math.min(p.video, role.maxBitrate - audio));
    out.push({ id: p.id, label: p.label, height, videoBitrate: video, audioBitrate: audio, estBytes: estimateBytes(video, audio, src.runtimeTicks) });
  }
  const secs = (src.runtimeTicks ?? 0) / 1e7;
  if (src.originalEligible && src.sizeBytes && secs > 0 && (src.sizeBytes * 8) / secs <= role.maxBitrate) {
    out.push({ id: 'original', label: 'Original', height: null, videoBitrate: null, audioBitrate: null, estBytes: src.sizeBytes });
  }
  return out;
}

// ---- helpers ----

interface LicenseRow {
  id: string;
  user_id: string;
  device_id: string;
  profile_id: string;
  item_id: string;
  job_id: string | null;
  quality: Quality;
  status: 'pending' | 'fetched' | 'deleted' | 'revoked';
  created_at: Date;
  fetched_at: Date | null;
  expires_at: Date;
  checked_at: Date;
  progress_at: Date | null;
  subs: Array<{ lang: string; title: string; url: string }>;
  meta: LicenseMeta;
}
interface LicenseMeta {
  title?: string;
  seriesName?: string;
  seriesId?: string;
  season?: number;
  episode?: number;
  runtimeTicks?: number;
  type?: string;
  posterId?: string;
  backdropId?: string;
  mediaSourceId?: string;
  bytes?: number;
  audioLang?: string;
}
export interface JobRow {
  id: string;
  item_id: string;
  quality: Quality;
  audio_lang: string;
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

/**
 * Error codes of a preparation in API answers (`prep.error`), never sentences: the web app shows its own texts.
 * The raw error stays in logs and the admin overview.
 */
export const PREP_FAILED = 'prep_failed';
/** the preparation job of a license no longer exists (cleaned up) */
export const PREP_GONE = 'prep_gone';
const ACTIVE = "status in ('pending','fetched')";
const graceMs = (ctx: Pick<Ctx, 'cfg'>) => ctx.cfg.DOWNLOAD_OFFLINE_GRACE_DAYS * 86_400_000;
export const validUntil = (ctx: Pick<Ctx, 'cfg'>, expiresAt: Date, from = Date.now()) => new Date(Math.min(expiresAt.getTime(), from + graceMs(ctx)));

export class DownloadError extends Error {
  constructor(public status: number, public code: string, public extra: Record<string, unknown> = {}) {
    super(code);
  }
}

// serialises license creation per account inside this process (quota is checked then inserted)
const chains = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return next;
}

export async function activeCount(ctx: Pick<Ctx, 'db'>, userId: string): Promise<number> {
  const r = await ctx.db.query<{ n: string }>(`select count(*) n from downloads where user_id=$1 and ${ACTIVE} and expires_at > now()`, [userId]);
  return Number(r.rows[0]?.n ?? 0);
}

const pickAudio = (src: DownloadSourceInfo, lang: string | undefined) => {
  if (!lang) return undefined;
  const l = lang.toLowerCase();
  return src.audio.find((a) => a.lang.toLowerCase() === l);
};

function metaOf(i: ItemDto, src: DownloadSourceInfo, audioLang: string): LicenseMeta {
  const episode = i.type === 'Episode';
  return {
    title: i.name,
    seriesName: i.seriesName,
    seriesId: i.seriesId,
    season: i.parentIndexNumber,
    episode: i.indexNumber,
    runtimeTicks: i.runtimeTicks ?? src.runtimeTicks ?? undefined,
    type: i.type,
    posterId: i.image ? i.id : episode ? i.seriesId : undefined,
    backdropId: i.backdrop ? i.id : episode ? i.seriesId : undefined,
    mediaSourceId: src.mediaSourceId,
    audioLang,
  };
}

export interface CreateRequest {
  itemId?: string;
  seriesId?: string;
  fromEpisodeId?: string;
  count?: number;
  quality: Quality;
  audioLang?: string;
  subLangs?: string[];
}

export interface DownloadContext {
  user: UserRow;
  profileId: string;
  jfUser: JfUser;
  deviceId: string;
  role: DownloadRole;
}

/** Resolves item ids for a request: one item, or an episode followed by the next N-1 episodes of the series (across seasons). */
async function expandItems(ctx: Ctx, jfUser: JfUser, req: CreateRequest): Promise<ItemDto[]> {
  if (req.itemId) return [await ctx.jf.item(jfUser, req.itemId)];
  const first = await ctx.jf.item(jfUser, req.fromEpisodeId!);
  const series = first.seriesId ?? req.seriesId;
  const items = [first];
  const n = Math.min(req.count ?? 1, 10);
  while (items.length < n && series) {
    const next = await ctx.jf.nextEpisode(jfUser, series, items[items.length - 1]!.id);
    if (!next) break;
    items.push(next);
  }
  return items;
}

/** Quality for one item: the requested one when offered, `original` falls back to the best transcode, otherwise null. */
function resolveQuality(opts: QualityOption[], wanted: Quality): Quality | null {
  if (opts.some((o) => o.id === wanted)) return wanted;
  if (wanted === 'original') return opts.some((o) => o.id === 'hd') ? 'hd' : opts[opts.length - 1]?.id ?? null;
  return null;
}

/** Everything one new license needs, resolved against Jellyfin before anything is written. */
interface PlannedLicense {
  item: ItemDto;
  src: DownloadSourceInfo;
  quality: Quality;
  audioLang: string;
  subs: Array<{ lang: string; title: string; url: string }>;
  /** effective caps of the prepared file (role clamp); null for `original` (no job) */
  job: { maxHeight: number; maxBitrate: number } | null;
}

/**
 * Creates the licenses (one per item) and queues the preparation jobs. Items the profile already holds on this device are returned as they are.
 * All sources/qualities are resolved first (any Jellyfin error aborts before a write), then jobs + licenses are inserted in ONE transaction.
 * The request never waits for preparation: the preparer tick (server.ts) picks queued jobs up; with BACKGROUND_JOBS=true it is also kicked right away.
 */
export async function createDownloads(ctx: Ctx, dc: DownloadContext, req: CreateRequest): Promise<{ licenses: LicenseView[]; quota: { used: number; max: number } }> {
  const { user, role } = dc;
  if (!roleAllowsDownloads(ctx, role)) throw new DownloadError(403, 'downloads_not_allowed');
  if (dc.deviceId.startsWith('tv-')) throw new DownloadError(403, 'device_not_supported');
  const items = await expandItems(ctx, dc.jfUser, req).catch(() => {
    throw new DownloadError(404, 'not_found');
  });
  for (const i of items) if (i.type !== 'Movie' && i.type !== 'Episode') throw new DownloadError(400, 'not_downloadable');

  return serial(user.id, async () => {
    const existing = new Map((await ctx.db.query<LicenseRow>(`select * from downloads where user_id=$1 and device_id=$2 and profile_id=$3 and ${ACTIVE}`, [user.id, dc.deviceId, dc.profileId])).rows.map((r) => [r.item_id, r]));
    const fresh = items.filter((i) => !existing.has(i.id));
    const used = await activeCount(ctx, user.id);
    // a request that cannot fit entirely is refused (the client then offers fewer episodes)
    if (used + fresh.length > role.maxDownloads) throw new DownloadError(409, 'quota_exceeded', { used, max: role.maxDownloads, wanted: fresh.length });

    // 1. resolve (read-only)
    const plan: PlannedLicense[] = [];
    for (const item of fresh) {
      let src: DownloadSourceInfo;
      try {
        src = await ctx.jf.downloadSource(dc.jfUser, item.id, { quality: 'original', maxHeight: downloadHeightCap(role), maxBitrate: role.maxBitrate });
      } catch (e) {
        console.warn(`download source for ${item.id} failed: ${(e as Error).message}`);
        throw new DownloadError(502, 'upstream_failed');
      }
      const opts = qualityOptions(role, src);
      const quality = resolveQuality(opts, req.quality);
      if (!quality) throw new DownloadError(400, 'quality_unavailable', { itemId: item.id });
      const opt = opts.find((o) => o.id === quality)!;
      const wantAudio = pickAudio(src, req.audioLang);
      const audioLang = quality === 'original' ? '' : wantAudio?.lang.toLowerCase() ?? '';
      const subLangs = new Set((req.subLangs ?? []).map((l) => l.toLowerCase()));
      const seen = new Set<string>();
      const subs = src.subtitles
        .filter((s) => subLangs.has(s.lang.toLowerCase()) && !seen.has(s.lang.toLowerCase()) && seen.add(s.lang.toLowerCase()))
        .map((s) => ({ lang: s.lang, title: s.title, url: s.url }));
      const job = quality === 'original' ? null : { maxHeight: opt.height ?? 0, maxBitrate: (opt.videoBitrate ?? 0) + (opt.audioBitrate ?? 0) };
      plan.push({ item, src, quality, audioLang, subs, job });
    }

    // 2. write (one transaction: all or nothing)
    const expiresAt = new Date(Date.now() + role.downloadDays * 86_400_000);
    const ids: string[] = items.filter((i) => existing.has(i.id)).map((i) => existing.get(i.id)!.id);
    const toEnqueue: string[] = [];
    if (plan.length) {
      const c = await (ctx.db as pg.Pool).connect();
      try {
        await c.query('begin');
        const tx = { db: c as unknown as Ctx['db'] };
        for (const p of plan) {
          const jobId = p.job ? await ensureJob(tx, p.item.id, p.quality, p.audioLang, p.job.maxHeight, p.job.maxBitrate, p.src.mediaSourceId, toEnqueue) : null;
          const id = randomUUID();
          const ins = await c.query(
            `insert into downloads(id, user_id, device_id, profile_id, item_id, job_id, quality, status, expires_at, subs, meta)
             values ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10) on conflict do nothing`,
            [id, user.id, dc.deviceId, dc.profileId, p.item.id, jobId, p.quality, expiresAt, JSON.stringify(p.subs), JSON.stringify(metaOf(p.item, p.src, p.audioLang))],
          );
          if (ins.rowCount) ids.push(id);
        }
        await c.query('commit');
      } catch (e) {
        await c.query('rollback').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    }
    // never wait for preparation here; without background jobs the rows alone are enough (the preparer tick finds them)
    if (ctx.cfg.BACKGROUND_JOBS === 'true') for (const j of new Set(toEnqueue)) void enqueueJob(ctx, j).catch(() => undefined);
    const byId = new Map((await ctx.db.query<LicenseRow>('select * from downloads where id = any($1::uuid[])', [ids])).rows.map((r) => [r.id, r]));
    const rows = ids.map((id) => byId.get(id)).filter((r): r is LicenseRow => Boolean(r)); // request order (rows of one transaction share created_at)
    return { licenses: await viewLicenses(ctx, rows), quota: { used: await activeCount(ctx, user.id), max: role.maxDownloads } };
  });
}

/** Finds the shared (item, quality, audio, caps) job or creates it; new/queued jobs are collected for enqueueing. Runs inside the creation transaction. */
async function ensureJob(ctx: Pick<Ctx, 'db'>, itemId: string, quality: Quality, audioLang: string, maxHeight: number, maxBitrate: number, mediaSourceId: string, toEnqueue: string[]): Promise<string> {
  const id = randomUUID();
  const ins = await ctx.db.query<{ id: string }>(
    `insert into download_jobs(id, item_id, quality, audio_lang, max_height, max_bitrate, media_source_id, status) values ($1,$2,$3,$4,$5,$6,$7,'queued')
     on conflict (item_id, quality, audio_lang, max_height, max_bitrate) where status <> 'failed' do nothing returning id`,
    [id, itemId, quality, audioLang, maxHeight, maxBitrate, mediaSourceId],
  );
  if (ins.rows[0]) {
    toEnqueue.push(id);
    return id;
  }
  // updated_at too: gc must not take a job away that a license is being attached to right now
  const cur = (await ctx.db.query<{ id: string; status: string }>(
    "update download_jobs set last_used_at=now(), updated_at=now() where item_id=$1 and quality=$2 and audio_lang=$3 and max_height=$4 and max_bitrate=$5 and status <> 'failed' returning id, status",
    [itemId, quality, audioLang, maxHeight, maxBitrate],
  )).rows[0];
  if (!cur) return ensureJob(ctx, itemId, quality, audioLang, maxHeight, maxBitrate, mediaSourceId, toEnqueue); // failed + replaced between the two statements
  if (cur.status === 'queued') toEnqueue.push(cur.id); // enqueueJob is idempotent
  return cur.id;
}

/** Jobs that no pending license waits for any more are cancelled (queued/preparing -> failed 'cancelled'); a running preparation stops at its next segment. */
export async function releaseJobs(ctx: Ctx, jobIds: Array<string | null | undefined>): Promise<void> {
  const ids = [...new Set(jobIds.filter((x): x is string => Boolean(x)))];
  if (!ids.length) return;
  const r = await ctx.db.query<{ id: string }>(
    `update download_jobs j set status='failed', error='cancelled', updated_at=now()
      where j.id = any($1::uuid[]) and j.status in ('queued','preparing') and not exists (select 1 from downloads d where d.job_id=j.id and d.status='pending')
      returning j.id`,
    [ids],
  );
  for (const row of r.rows) preparer(ctx).cancel(row.id);
}

// ---- views ----

export interface LicenseView {
  id: string;
  itemId: string;
  status: 'pending' | 'fetched' | 'deleted' | 'revoked';
  /** pending licenses: is the file downloadable yet */
  ready: boolean;
  prep: { status: 'queued' | 'preparing' | 'ready' | 'failed'; percent: number; /** code, never a sentence */ error: typeof PREP_FAILED | typeof PREP_GONE | null };
  fileUrl: string;
  bytes: number | null;
  quality: Quality;
  audioLang: string;
  subtitles: Array<{ lang: string; title: string; url: string }>;
  poster: string | null;
  backdrop: string | null;
  title: string;
  seriesName: string | null;
  seriesId: string | null;
  season: number | null;
  episode: number | null;
  runtimeTicks: number | null;
  profileId: string;
  createdAt: Date;
  expiresAt: Date;
  validUntil: Date;
}

async function loadJobs(ctx: Pick<Ctx, 'db'>, ids: string[]): Promise<Map<string, JobRow>> {
  if (!ids.length) return new Map();
  const r = await ctx.db.query<JobRow>('select * from download_jobs where id = any($1::uuid[])', [ids]);
  return new Map(r.rows.map((j) => [j.id, j]));
}

export async function viewLicenses(ctx: Ctx, rows: LicenseRow[]): Promise<LicenseView[]> {
  const jobs = await loadJobs(ctx, [...new Set(rows.map((r) => r.job_id).filter((x): x is string => Boolean(x)))]);
  return rows.map((r) => {
    const job = r.job_id ? jobs.get(r.job_id) : undefined;
    let prep: LicenseView['prep'];
    if (r.quality === 'original') prep = { status: 'ready', percent: 100, error: null };
    else if (!job) prep = { status: 'failed', percent: 0, error: PREP_GONE };
    else prep = { status: job.status, percent: job.status === 'ready' ? 100 : Math.max(0, Math.min(100, Math.round(jobProgress(job)))), error: job.status === 'failed' ? PREP_FAILED : null };
    const m = r.meta ?? {};
    const bytes = job?.bytes != null ? Number(job.bytes) : m.bytes ?? null;
    return {
      id: r.id,
      itemId: r.item_id,
      status: r.status,
      ready: prep.status === 'ready',
      prep,
      fileUrl: `/media/d/${r.id}`,
      bytes,
      quality: r.quality,
      audioLang: m.audioLang ?? '',
      subtitles: r.subs ?? [],
      poster: m.posterId ? `/media/Items/${m.posterId}/Images/Primary?maxWidth=300&quality=85` : null,
      backdrop: m.backdropId ? `/media/Items/${m.backdropId}/Images/Backdrop?maxWidth=1280&quality=80` : null,
      title: m.title ?? '',
      seriesName: m.seriesName ?? null,
      seriesId: m.seriesId ?? null,
      season: m.season ?? null,
      episode: m.episode ?? null,
      runtimeTicks: m.runtimeTicks ?? null,
      profileId: r.profile_id,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      validUntil: validUntil(ctx, r.expires_at, r.checked_at.getTime()),
    };
  });
}

/** Active licenses of one profile on one device. */
export async function listLicenses(ctx: Ctx, userId: string, deviceId: string, profileId: string): Promise<LicenseView[]> {
  const r = await ctx.db.query<LicenseRow>(`select * from downloads where user_id=$1 and device_id=$2 and profile_id=$3 and ${ACTIVE} order by created_at, id`, [userId, deviceId, profileId]);
  return viewLicenses(ctx, r.rows);
}

export async function getLicense(ctx: Ctx, userId: string, deviceId: string, profileId: string, id: string): Promise<LicenseView | null> {
  const r = await ctx.db.query<LicenseRow>('select * from downloads where id=$1 and user_id=$2 and device_id=$3 and profile_id=$4', [id, userId, deviceId, profileId]);
  if (!r.rows[0]) return null;
  if (r.rows[0].job_id) await ctx.db.query("update download_jobs set last_used_at=now() where id=$1 and last_used_at < now() - interval '1 minute'", [r.rows[0].job_id]);
  return (await viewLicenses(ctx, r.rows))[0]!;
}

// ---- state changes ----

export async function markFetched(ctx: Pick<Ctx, 'db'>, userId: string, deviceId: string, profileId: string, id: string, bytes?: number): Promise<boolean> {
  const r = await ctx.db.query(
    `update downloads set status='fetched', fetched_at=coalesce(fetched_at, now()), meta = case when $4::bigint is null then meta else meta || jsonb_build_object('bytes', $4::bigint) end
      where id=$1 and user_id=$2 and device_id=$3 and profile_id=$5 and ${ACTIVE}`,
    [id, userId, deviceId, bytes ?? null, profileId],
  );
  if ((r.rowCount ?? 0) > 0) {
    await ctx.db.query("update download_jobs set last_used_at=now() where id=(select job_id from downloads where id=$1) and last_used_at < now() - interval '1 minute'", [id]);
    return true;
  }
  return false;
}

export async function deleteLicense(ctx: Ctx, userId: string, deviceId: string, profileId: string, id: string): Promise<boolean> {
  const r = await ctx.db.query<{ job_id: string | null }>("update downloads set status='deleted' where id=$1 and user_id=$2 and device_id=$3 and profile_id=$4 and status in ('pending','fetched') returning job_id", [id, userId, deviceId, profileId]);
  await releaseJobs(ctx, r.rows.map((x) => x.job_id));
  return r.rows.length > 0;
}

/** Marks licenses revoked: all of an account, or one device (`deviceId`), or all devices but one (`exceptDeviceId`). Returns the count. */
export async function revokeDownloads(ctx: Ctx, userId: string, deviceId?: string, exceptDeviceId?: string): Promise<number> {
  const r = deviceId
    ? await ctx.db.query<{ job_id: string | null }>(`update downloads set status='revoked' where user_id=$1 and device_id=$2 and ${ACTIVE} returning job_id`, [userId, deviceId])
    : exceptDeviceId
      ? await ctx.db.query<{ job_id: string | null }>(`update downloads set status='revoked' where user_id=$1 and device_id is distinct from $2 and ${ACTIVE} returning job_id`, [userId, exceptDeviceId])
      : await ctx.db.query<{ job_id: string | null }>(`update downloads set status='revoked' where user_id=$1 and ${ACTIVE} returning job_id`, [userId]);
  await releaseJobs(ctx, r.rows.map((x) => x.job_id));
  return r.rows.length;
}

/** Revokes a single license (admin). */
export async function revokeLicense(ctx: Ctx, id: string): Promise<boolean> {
  const r = await ctx.db.query<{ job_id: string | null }>(`update downloads set status='revoked' where id=$1 and ${ACTIVE} returning job_id`, [id]);
  await releaseJobs(ctx, r.rows.map((x) => x.job_id));
  return r.rows.length > 0;
}

/**
 * Check-in of a device: every id the device still holds comes back valid (with a renewed offline window, capped by the license expiry)
 * or revoked (unknown id, other device or profile, user disabled, device not approved, role no longer allows downloads, expired).
 */
export async function checkLicenses(ctx: Ctx, user: UserRow, deviceId: string, profileId: string, ids: string[]): Promise<{ valid: Array<{ id: string; expiresAt: Date; validUntil: Date }>; revoked: string[] }> {
  const rows = ids.length ? (await ctx.db.query<LicenseRow>('select * from downloads where id = any($1::uuid[]) and user_id=$2 and device_id=$3 and profile_id=$4', [ids, user.id, deviceId, profileId])).rows : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const dev = (await ctx.db.query<{ approved: boolean }>('select approved from devices where user_id=$1 and device_id=$2', [user.id, deviceId])).rows[0];
  const role = await effectiveRole(ctx, user.role);
  const allowed = !user.disabled && Boolean(dev?.approved) && roleAllowsDownloads(ctx, role);
  const now = Date.now();
  const valid: Array<{ id: string; expiresAt: Date; validUntil: Date }> = [];
  const revoked: string[] = [];
  const renew: string[] = [];
  const kill: string[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || !allowed || (r.status !== 'pending' && r.status !== 'fetched') || r.expires_at.getTime() <= now) {
      revoked.push(id);
      if (r && (r.status === 'pending' || r.status === 'fetched') && (!allowed || r.expires_at.getTime() > now)) kill.push(id);
      continue;
    }
    valid.push({ id, expiresAt: r.expires_at, validUntil: validUntil(ctx, r.expires_at, now) });
    renew.push(id);
  }
  if (renew.length) await ctx.db.query('update downloads set checked_at=now() where id = any($1::uuid[])', [renew]);
  if (kill.length) {
    const k = await ctx.db.query<{ job_id: string | null }>("update downloads set status='revoked' where id = any($1::uuid[]) returning job_id", [kill]);
    await releaseJobs(ctx, k.rows.map((x) => x.job_id));
  }
  return { valid, revoked };
}

// ---- watch progress made offline ----

export interface ProgressEvent { downloadId: string; itemId: string; positionTicks: number; played: boolean; at: number }

/**
 * Applies offline watch progress to Jellyfin. Per item only the newest event counts; its time is clamped to [license created, now] and it is
 * only written when newer than the item's Jellyfin LastPlayedDate (so a later online viewing is never overwritten).
 */
export async function syncProgress(ctx: Ctx, user: UserRow, deviceId: string, profileId: string, events: ProgressEvent[]): Promise<{ applied: string[]; skipped: string[] }> {
  const ids = [...new Set(events.map((e) => e.downloadId))];
  const lic = new Map((await ctx.db.query<LicenseRow>('select * from downloads where id = any($1::uuid[]) and user_id=$2 and device_id=$3 and profile_id=$4', [ids, user.id, deviceId, profileId])).rows.map((r) => [r.id, r]));
  const newest = new Map<string, { e: ProgressEvent; l: LicenseRow; at: number }>();
  const skipped: string[] = [];
  const now = Date.now();
  for (const e of events) {
    const l = lic.get(e.downloadId);
    if (!l || l.status === 'revoked' || l.item_id !== e.itemId) {
      skipped.push(e.itemId);
      continue;
    }
    const at = Math.min(now, Math.max(l.created_at.getTime(), e.at));
    const cur = newest.get(e.itemId);
    if (!cur || at >= cur.at) newest.set(e.itemId, { e, l, at });
  }
  const applied: string[] = [];
  const profiles = new Map<string, JfUser | null>();
  for (const [itemId, { e, l, at }] of newest) {
    if (!profiles.has(l.profile_id)) {
      const p = await getProfile(ctx, user.id, l.profile_id);
      profiles.set(l.profile_id, p ? jfUserFor(user, p) : null);
    }
    const jf = profiles.get(l.profile_id);
    if (!jf) { skipped.push(itemId); continue; }
    const item = await ctx.jf.item(jf, itemId).catch(() => null);
    if (!item) { skipped.push(itemId); continue; }
    const last = item.lastPlayedDate ? Date.parse(item.lastPlayedDate) : 0;
    if (last && last >= at) { skipped.push(itemId); continue; }
    const runtime = item.runtimeTicks ?? l.meta?.runtimeTicks ?? 0;
    const played = e.played || (runtime > 0 && e.positionTicks / runtime >= 0.9);
    await ctx.jf.setUserData(jf, itemId, { positionTicks: played ? 0 : Math.max(0, Math.round(e.positionTicks)), played, lastPlayedDate: new Date(at).toISOString() });
    applied.push(itemId);
  }
  if (ids.length) await ctx.db.query('update downloads set progress_at=now() where id = any($1::uuid[]) and user_id=$2', [[...lic.keys()], user.id]);
  return { applied, skipped };
}

// ---- gateway authorisation ----

export type DownloadAuthz =
  | { kind: 'file'; file: string; size: number; etag: string }
  | { kind: 'static'; path: string; query: Record<string, string> };

/** Short memo of "may this licence's profile still see the item" (like /internal/authz/item); errors are never memoised. */
const VISIBLE_MEMO_MS = 5_000;
const visibleMemo = new Map<string, { exp: number; v: boolean }>();
export const forgetDownloadVisibility = () => visibleMemo.clear();

/** Used by /internal/authz {sid, dl}: may this session (with its active profile) fetch this license's file? null = no (the gateway answers 404). */
export async function authorizeDownload(ctx: Ctx, session: Pick<Session, 'userId' | 'deviceId'>, user: Pick<UserRow, 'id' | 'role' | 'disabled'> & JfUser, profileId: string, downloadId: string): Promise<DownloadAuthz | null> {
  if (!downloadsEnabled(ctx) || !session.deviceId || user.disabled || session.userId !== user.id) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(downloadId)) return null;
  const lic = (await ctx.db.query<LicenseRow>(`select * from downloads where id=$1 and user_id=$2 and device_id=$3 and profile_id=$4 and ${ACTIVE} and expires_at > now()`, [downloadId, user.id, session.deviceId, profileId])).rows[0];
  if (!lic) return null;
  const dev = (await ctx.db.query<{ approved: boolean }>('select approved from devices where user_id=$1 and device_id=$2', [user.id, session.deviceId])).rows[0];
  if (!dev?.approved) return null;
  if (!roleAllowsDownloads(ctx, await effectiveRole(ctx, user.role))) return null;
  // The media server may use one shared token (no per-user enforcement upstream): the profile must still be able to see the item
  // (re-rating, kids cap, role libraries). Not visible -> deny and revoke the licence.
  const vkey = `${lic.id}|${profileId}`;
  let visible = visibleMemo.get(vkey);
  if (!visible || visible.exp <= Date.now()) {
    const prof = await getProfile(ctx, user.id, profileId);
    if (!prof) return null;
    let v: boolean;
    try {
      await ctx.jf.item(jfUserFor(user, prof), lic.item_id);
      v = true;
    } catch (e) {
      if (!(e instanceof MediaError) || ![400, 403, 404].includes(e.status)) throw e; // server trouble: not memoised, not a revoke
      v = false;
    }
    visible = { exp: Date.now() + VISIBLE_MEMO_MS, v };
    visibleMemo.set(vkey, visible);
    if (visibleMemo.size > 5000) visibleMemo.clear();
  }
  if (!visible.v) {
    const k = await ctx.db.query<{ job_id: string | null }>(`update downloads set status='revoked' where id=$1 and ${ACTIVE} returning job_id`, [lic.id]);
    await releaseJobs(ctx, k.rows.map((x) => x.job_id));
    return null;
  }
  if (!lic.job_id) {
    const ms = lic.meta?.mediaSourceId;
    if (lic.quality !== 'original' || !ms || !/^[\w-]{1,64}$/.test(ms)) return null;
    return { kind: 'static', path: `/Videos/${lic.item_id}/stream`, query: { static: 'true', MediaSourceId: ms } };
  }
  const job = (await ctx.db.query<JobRow>('select * from download_jobs where id=$1', [lic.job_id])).rows[0];
  if (!job || job.status !== 'ready' || job.bytes == null) return null;
  await ctx.db.query("update download_jobs set last_used_at=now() where id=$1 and last_used_at < now() - interval '1 minute'", [job.id]);
  const size = Number(job.bytes);
  return { kind: 'file', file: `${job.id}.mp4`, size, etag: `${job.id}-${size}` };
}

/** Housekeeping: drops old deleted/revoked/expired license rows so jobs lose their references. Returns the number removed. */
export async function gcLicenses(ctx: Pick<Ctx, 'db'>): Promise<number> {
  const r = await ctx.db.query(
    `delete from downloads where (status in ('deleted','revoked') and coalesce(progress_at, checked_at, created_at) < now() - interval '30 days')
        or expires_at < now() - interval '30 days'`,
  );
  return r.rowCount ?? 0;
}

/** Admin overview: jobs, disk usage and active licenses. */
export async function adminOverview(ctx: Pick<Ctx, 'db'>) {
  const jobs = (await ctx.db.query(
    `select j.id, j.item_id, j.quality, j.audio_lang, j.max_height, j.max_bitrate, j.status, j.seg_done, j.seg_total, j.bytes, j.error, j.created_at, j.updated_at, j.last_used_at,
            (select d.meta->>'title' from downloads d where d.job_id=j.id and d.meta->>'title' is not null order by d.created_at desc limit 1) title,
            (select d.meta->>'seriesName' from downloads d where d.job_id=j.id and d.meta->>'title' is not null order by d.created_at desc limit 1) series_name,
            (select count(*) from downloads d where d.job_id=j.id and d.status in ('pending','fetched'))::int licenses
       from download_jobs j order by j.created_at desc limit 200`,
  )).rows;
  const licenses = (await ctx.db.query(
    `select d.id, d.user_id, u.name user_name, d.device_id, dv.label device_label, d.item_id, d.quality, d.status, d.created_at, d.fetched_at, d.expires_at, d.meta->>'title' title, d.meta->>'seriesName' series_name
       from downloads d join users u on u.id=d.user_id left join devices dv on dv.user_id=d.user_id and dv.device_id=d.device_id
      where d.status in ('pending','fetched') order by d.created_at desc limit 300`,
  )).rows;
  const disk = (await ctx.db.query<{ bytes: string | null }>("select coalesce(sum(bytes),0)::text bytes from download_jobs where status='ready'")).rows[0]?.bytes ?? '0';
  const byStatus = Object.fromEntries((await ctx.db.query<{ status: string; n: string }>('select status, count(*) n from download_jobs group by status')).rows.map((r) => [r.status, Number(r.n)]));
  return { jobs, licenses, diskBytes: Number(disk), jobCounts: byStatus };
}
