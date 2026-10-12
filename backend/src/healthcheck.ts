import type { Ctx } from './ctx.js';
import { broadcastLanguage, m, msg, type Text } from './i18n.js';
import { notify } from './notify.js';
import { libraryItems, previews, serviceUser } from './previews.js';
import type { UserRow } from './types.js';

export interface CheckResult { itemId: string; name: string; type: string; ok: boolean; status: number | null; ms: number; bytes: number; error: string | null }
export interface CheckState { running: boolean; done: number; total: number; startedAt: string | null; finishedAt: string | null; results: CheckResult[] }

const SEG_TIMEOUT_MS = 60_000;
const jobs = new WeakMap<Ctx, CheckState>();

const resolve = (base: string, uri: string) => { const u = new URL(uri, new URL(base, 'http://jf.invalid')); return u.pathname + u.search; };
const lines = (p: string) => p.split(/\r?\n/).map((l) => l.trim());

/** Test-transcodes one segment of an item (a series: its first episode) exactly like a preview clip would. */
export async function probe(ctx: Ctx, user: UserRow, item: { id: string; type: string }): Promise<Pick<CheckResult, 'ok' | 'status' | 'bytes' | 'error'>> {
  let status: number | null = null;
  let encoding: { deviceId: string; playSessionId: string } | undefined;
  try {
    let videoId = item.id;
    if (item.type === 'Series') {
      const ep = await ctx.jf.firstEpisode(user, item.id);
      if (!ep) throw new Error('no episode');
      videoId = ep.id;
    }
    const info = await ctx.jf.playbackInfo(user, videoId, { maxBitrate: 1_500_000 });
    const master = new URL(info.hlsUrl.replace(/^\/media/, ''), 'http://jf.invalid');
    const q = master.searchParams;
    for (const [k, v] of Object.entries({ AllowVideoStreamCopy: 'false', AllowAudioStreamCopy: 'false', VideoBitrate: '1200000', AudioBitrate: '128000', MaxWidth: '1280' })) q.set(k, v);
    const masterPath = master.pathname + master.search;
    encoding = { deviceId: ctx.jf.deviceId(user), playSessionId: q.get('PlaySessionId') ?? info.playSessionId };
    const get = async (path: string) => {
      const res = await ctx.jf.call(user, path, { signal: AbortSignal.timeout(SEG_TIMEOUT_MS) });
      status = res.status;
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`.trim());
      return res;
    };
    const variant = lines(await (await get(masterPath)).text()).find((l) => l && !l.startsWith('#'));
    if (!variant) throw new Error('no variant');
    const mediaPath = resolve(masterPath, variant);
    const segs = lines(await (await get(mediaPath)).text()).filter((l) => l && !l.startsWith('#'));
    if (!segs.length) throw new Error('empty playlist');
    const body = Buffer.from(await (await get(resolve(mediaPath, segs[Math.min(5, segs.length - 1)]!))).arrayBuffer());
    if (!body.length) throw new Error('HTTP 200 empty body');
    return { ok: true, status, bytes: body.length, error: null };
  } catch (e) {
    return { ok: false, status, bytes: 0, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  } finally {
    if (encoding) await ctx.jf.call(user, `/Videos/ActiveEncodings?${new URLSearchParams(encoding)}`, { method: 'DELETE' }).catch(() => undefined);
  }
}

async function run(ctx: Ctx, st: CheckState, user: UserRow): Promise<void> {
  const pv = previews(ctx);
  pv.paused = true;
  try {
    const lib = await libraryItems(ctx, user);
    st.total = lib.length;
    for (const item of lib) {
      await pv.whenIdle(); // never transcode next to a preview clip
      const t0 = Date.now();
      const r = await probe(ctx, user, item);
      st.results.push({ itemId: item.id, name: item.name, type: item.type, ms: Date.now() - t0, ...r });
      st.done++;
    }
  } catch (e) {
    st.results.push({ itemId: '', name: msg(await broadcastLanguage(ctx).catch(() => 'de' as const), 'check.aborted'), type: '', ok: false, status: null, ms: 0, bytes: 0, error: String(e).slice(0, 200) });
  } finally {
    pv.paused = false;
    st.finishedAt = new Date().toISOString();
    const id = (await ctx.db.query<{ id: string }>('insert into playback_checks(started_at, finished_at, results) values ($1,$2,$3) returning id', [st.startedAt, st.finishedAt, JSON.stringify(st.results)]).catch(() => undefined))?.rows[0]?.id;
    if (id) await notifyNewFailures(ctx, id, st.results).catch(() => undefined);
    st.running = false; // only after the report is stored
  }
}

/** Tells every admin about titles that fail now but did not in the previous stored report. */
async function notifyNewFailures(ctx: Ctx, id: string, results: CheckResult[]): Promise<void> {
  const prev = (await ctx.db.query<{ results: CheckResult[] }>('select results from playback_checks where id < $1 order by id desc limit 1', [id])).rows[0];
  const was = new Set((prev?.results ?? []).filter((r) => !r.ok).map((r) => r.itemId));
  const fresh = results.filter((r) => !r.ok && r.itemId && !was.has(r.itemId));
  if (!fresh.length) return;
  const shown = fresh.slice(0, 5).map((r) => r.name).join(', ');
  const names: Text = fresh.length > 5 ? m('more', { list: shown, n: fresh.length - 5 }) : shown;
  const admins = (await ctx.db.query<{ id: string }>("select id from users where role='admin' and not disabled")).rows;
  for (const a of admins) {
    await notify(ctx, { userId: a.id, kind: 'playback_check', title: m('check.failed', { n: fresh.length }), body: names, link: '/admin/playback', dedupe: `playback-check-${id}-${a.id}`, external: true });
  }
}

/** Timer tick: starts the nightly run at PLAYBACK_CHECK_HOUR (local time) unless one ran today or is running. */
export async function nightlyTick(ctx: Ctx, now = new Date()): Promise<boolean> {
  const hour = ctx.cfg.PLAYBACK_CHECK_HOUR;
  if (hour < 0 || now.getHours() !== hour || jobs.get(ctx)?.running) return false;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if ((await ctx.db.query('select 1 from playback_checks where started_at >= $1 limit 1', [midnight])).rowCount) return false;
  return startPlaybackCheck(ctx);
}

/** Starts the background job; false when one is already running (one per process). */
export async function startPlaybackCheck(ctx: Ctx): Promise<boolean> {
  if (jobs.get(ctx)?.running) return false;
  const st: CheckState = { running: true, done: 0, total: 0, startedAt: new Date().toISOString(), finishedAt: null, results: [] };
  jobs.set(ctx, st); // claimed synchronously: a concurrent start sees it
  const user = await serviceUser(ctx);
  if (!user) { jobs.delete(ctx); return false; }
  void run(ctx, st, user);
  return true;
}

/** The current job, else the last stored report. */
export async function checkState(ctx: Ctx): Promise<CheckState> {
  const cur = jobs.get(ctx);
  if (cur) return cur;
  const r = (await ctx.db.query<{ started_at: Date; finished_at: Date; results: CheckResult[] }>('select * from playback_checks order by id desc limit 1')).rows[0];
  if (!r) return { running: false, done: 0, total: 0, startedAt: null, finishedAt: null, results: [] };
  return { running: false, done: r.results.length, total: r.results.length, startedAt: r.started_at.toISOString(), finishedAt: r.finished_at.toISOString(), results: r.results };
}
