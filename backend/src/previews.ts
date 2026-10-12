import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ctx } from './ctx.js';
import { normaliseFmp4 } from './fmp4.js';
import type { UserRow } from './types.js';

const SEG_SECONDS = 3;
const SEG_COUNT = 10; // 30 s
const FAIL_RETRY_MS = 7 * 24 * 3600_000;

export type ClipRow = { status: 'ok' | 'failed'; bytes: number | null; error: string | null; created_at: Date };
export const clipPath = (ctx: Pick<Ctx, 'cfg'>, itemId: string) => join(ctx.cfg.PREVIEW_DIR, `${itemId}.mp4`);

/** The service account that transcodes: independent of whoever hovered (guests may not transcode). */
export async function serviceUser(ctx: Pick<Ctx, 'db'>): Promise<UserRow | undefined> {
  return (await ctx.db.query<UserRow>("select * from users where role = 'admin' and not disabled order by created_at limit 1")).rows[0];
}

/** Resolves a (possibly relative) playlist URI against the playlist's own path; returns path + query for ctx.jf.call. */
function resolve(base: string, uri: string): string {
  const u = new URL(uri, new URL(base, 'http://jf.invalid'));
  return u.pathname + u.search;
}

async function fetchOk(ctx: Ctx, user: UserRow, path: string): Promise<Response> {
  const res = await ctx.jf.call(user, path);
  if (!res.ok) throw new Error(`Jellyfin ${path.split('?')[0]} -> ${res.status}`);
  return res;
}

/** Where to cut from: local trailer from 0, series first episode a quarter in, movie one third in. */
async function pickSource(ctx: Ctx, user: UserRow, id: string): Promise<{ videoId: string; startSec: number } | null> {
  const trailer = await ctx.jf.trailer(user, id);
  if (trailer) return { videoId: trailer, startSec: 0 };
  const tr = await ctx.jf.tracks(user, id);
  if (tr.type === 'Series') {
    const ep = await ctx.jf.firstEpisode(user, id);
    return ep?.runtimeTicks ? { videoId: ep.id, startSec: Math.floor(ep.runtimeTicks / 10_000_000 / 4) } : null;
  }
  if (tr.type === 'Movie' && tr.runtimeTicks) return { videoId: id, startSec: Math.floor(tr.runtimeTicks / 10_000_000 / 3) };
  return null;
}

const lang = (t: { language?: string }) => (t.language ?? '').toLowerCase();
/** Clips are shared: German, else English, else the file's default track, else the first. */
export function pickPreviewAudio<T extends { language?: string; isDefault: boolean }>(tracks: T[]): T | undefined {
  return tracks.find((t) => ['ger', 'deu', 'de'].includes(lang(t))) ?? tracks.find((t) => ['eng', 'en'].includes(lang(t))) ?? tracks.find((t) => t.isDefault) ?? tracks[0];
}

/** Transcodes the clip once (init segment + 10 HLS segments from Jellyfin), rebases its timestamps, stores it atomically. */
async function build(ctx: Ctx, user: UserRow, id: string): Promise<{ bytes: number; audioLang: string | null }> {
  const src = await pickSource(ctx, user, id);
  if (!src) throw new Error('no source');
  const info = await ctx.jf.playbackInfo(user, src.videoId, { maxBitrate: 1_500_000 });
  const master = new URL(info.hlsUrl.replace(/^\/media/, ''), 'http://jf.invalid');
  const q = master.searchParams;
  const audio = pickPreviewAudio(info.audioTracks);
  if (audio) q.set('AudioStreamIndex', String(audio.index));
  for (const [k, v] of Object.entries({
    SegmentContainer: 'mp4', VideoCodec: 'h264', AudioCodec: 'aac', AllowVideoStreamCopy: 'false', AllowAudioStreamCopy: 'false',
    VideoBitrate: '1200000', AudioBitrate: '128000', MaxWidth: '1280', TranscodingMaxAudioChannels: '2', MaxStreamingBitrate: '1500000',
  })) q.set(k, v);
  const masterPath = master.pathname + master.search;
  const encoding = { deviceId: ctx.jf.deviceId(user), playSessionId: q.get('PlaySessionId') ?? info.playSessionId };
  try {
    const lines = (p: string) => p.split(/\r?\n/).map((l) => l.trim());
    const variant = lines(await (await fetchOk(ctx, user, masterPath)).text()).find((l) => l && !l.startsWith('#'));
    if (!variant) throw new Error('no variant');
    const mediaPath = resolve(masterPath, variant);
    const media = lines(await (await fetchOk(ctx, user, mediaPath)).text());
    const map = media.find((l) => l.startsWith('#EXT-X-MAP:'))?.match(/URI="([^"]+)"/)?.[1];
    const segs = media.filter((l) => l && !l.startsWith('#'));
    const k = Math.floor(src.startSec / SEG_SECONDS);
    const pick = segs.slice(k, k + SEG_COUNT);
    if (!map || !pick.length) throw new Error('empty playlist');
    const parts: Buffer[] = [];
    for (const uri of [map, ...pick]) parts.push(Buffer.from(await (await fetchOk(ctx, user, resolve(mediaPath, uri))).arrayBuffer())); // sequentially: one transcode at a time
    const out = normaliseFmp4(Buffer.concat(parts));
    await mkdir(ctx.cfg.PREVIEW_DIR, { recursive: true });
    const file = clipPath(ctx, id);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, out);
    await rename(tmp, file);
    return { bytes: out.length, audioLang: audio ? lang(audio) || null : null };
  } finally {
    await ctx.jf.call(user, `/Videos/ActiveEncodings?${new URLSearchParams(encoding)}`, { method: 'DELETE' }).catch(() => undefined);
  }
}

class Previews {
  private tail: Promise<void> = Promise.resolve();
  private readonly inflight = new Map<string, Promise<void>>();
  private warming = false;
  constructor(private readonly ctx: Ctx) {}

  /** Set while a playback health check runs: the background warmer stays out of its way. */
  paused = false;
  /** Set while a download is being prepared: the warmer yields (on-demand clips still run). */
  downloadBusy = false;
  get idle() { return this.inflight.size === 0; }
  /** Ids currently generating or waiting in the queue. */
  queued(): string[] { return [...this.inflight.keys()]; }
  whenIdle() { return Promise.allSettled([...this.inflight.values()]).then(() => undefined); }

  async status(id: string): Promise<'ok' | 'failed' | 'none'> {
    const row = (await this.ctx.db.query<ClipRow>('select * from preview_clips where item_id = $1', [id])).rows[0];
    if (!row) return 'none';
    if (row.status === 'ok') return (await stat(clipPath(this.ctx, id)).then((s) => s.isFile(), () => false)) ? 'ok' : 'none';
    return Date.now() - row.created_at.getTime() < FAIL_RETRY_MS ? 'failed' : 'none';
  }

  /** At most one generation at a time process-wide; the same item is never queued twice. */
  enqueue(id: string): Promise<void> {
    const cur = this.inflight.get(id);
    if (cur) return cur;
    const p = this.tail.then(() => this.run(id));
    const done = p.catch(() => undefined);
    this.tail = done;
    this.inflight.set(id, p);
    void done.then(() => this.inflight.delete(id));
    return p;
  }

  private async run(id: string): Promise<void> {
    const { ctx } = this;
    // a request that saw "none" may enqueue after an identical job already finished: never transcode the same clip twice
    if ((await this.status(id)) === 'ok') return;
    const user = await serviceUser(ctx);
    if (!user) return; // nothing recorded: retried once an admin exists
    let bytes: number | null = null;
    let audioLang: string | null = null;
    let error: string | null = null;
    try {
      ({ bytes, audioLang } = await build(ctx, user, id));
    } catch (e) {
      error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    }
    await ctx.db.query(
      `insert into preview_clips(item_id, status, bytes, error, audio_lang) values ($1,$2,$3,$4,$5)
       on conflict (item_id) do update set status = excluded.status, bytes = excluded.bytes, error = excluded.error, audio_lang = excluded.audio_lang, created_at = now()`,
      [id, error ? 'failed' : 'ok', bytes, error, audioLang],
    );
  }

  async regenerate(id: string): Promise<void> {
    await this.inflight.get(id)?.catch(() => undefined);
    await rmClip(this.ctx, id);
    void this.enqueue(id).catch(() => undefined);
  }

  /** Re-queues every failed item. */
  async regenerateFailed(): Promise<number> {
    const ids = (await this.ctx.db.query<{ item_id: string }>("select item_id from preview_clips where status = 'failed'")).rows.map((r) => r.item_id);
    for (const id of ids) await this.regenerate(id);
    return ids.length;
  }

  /** Background warmer: if idle, generates the clip of ONE library title that has no row yet. */
  async warmTick(): Promise<void> {
    if (this.warming || this.paused || this.downloadBusy || !this.idle) return;
    this.warming = true;
    try {
      const { ctx } = this;
      const user = await serviceUser(ctx);
      if (!user) return;
      for (let start = 0; ; start += 200) {
        const page = await ctx.jf.items(user, { types: 'Movie,Series', limit: 200, start });
        if (!page.items.length) return;
        const have = new Set((await ctx.db.query<{ item_id: string }>('select item_id from preview_clips where item_id = any($1)', [page.items.map((i) => i.id)])).rows.map((r) => r.item_id));
        const next = page.items.find((i) => !have.has(i.id));
        if (next) return await this.enqueue(next.id);
        if (start + 200 >= page.total) return;
      }
    } finally {
      this.warming = false;
    }
  }
}

/** All library Movies + Series, listed as the service user. */
export async function libraryItems(ctx: Ctx, user: UserRow): Promise<Array<{ id: string; name: string; type: string }>> {
  const out: Array<{ id: string; name: string; type: string }> = [];
  for (let start = 0; ; start += 200) {
    const page = await ctx.jf.items(user, { types: 'Movie,Series', limit: 200, start });
    for (const i of page.items) out.push({ id: i.id, name: i.name, type: i.type });
    if (!page.items.length || start + 200 >= page.total) return out;
  }
}

async function rmClip(ctx: Ctx, id: string) {
  await ctx.db.query('delete from preview_clips where item_id = $1', [id]);
  await rm(clipPath(ctx, id), { force: true });
}

const instances = new WeakMap<Ctx, Previews>();
export function previews(ctx: Ctx): Previews {
  let p = instances.get(ctx);
  if (!p) instances.set(ctx, (p = new Previews(ctx)));
  return p;
}
