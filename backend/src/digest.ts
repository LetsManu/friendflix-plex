import type { Ctx } from './ctx.js';
import type { ItemDto } from './media/types.js';
import { m, userLanguage, type Text } from './i18n.js';
import { localizeStored, notify } from './notify.js';
import type { UserRow } from './types.js';

export interface DigestSchedule { enabled: boolean; day: number; hour: number; source: 'config' | 'admin' }

export interface DigestData {
  since: string;
  until: string;
  newMovies: Array<{ id: string; name: string; year?: number }>;
  newMovieCount: number;
  /** ids of (up to MAX_MOVIE_IDS of) all new movies: lets a restricted viewer count only the visible ones */
  movieIds?: string[];
  newEpisodes: Array<{ seriesId: string; seriesName: string; count: number; followed: boolean; episodes: Array<{ id: string; name: string; season?: number; episode?: number }> }>;
  newEpisodeCount: number;
  /** episode count per series for ALL series with new episodes (newEpisodes lists only the first MAX_SERIES) */
  seriesCounts?: Record<string, number>;
  available: Array<{ title: string; link: string | null; itemId: string | null }>;
  recommendations: Array<{ itemId: string; name: string; from: string; note: string | null; kind: 'recommended' | 'friends' }>;
}

const MAX_MOVIES = 12;
const MAX_EPISODES_PER_SERIES = 5;
const MAX_RECS = 5;
const MAX_SERIES = 20;
const MAX_MOVIE_IDS = 200;
const SCAN_CAP = 600;
const PAGE = 200;
const DAY_MS = 24 * 3600_000;

/** Effective schedule: the admin override (app_settings 'digest') wins over DIGEST_DAY / DIGEST_HOUR. */
export async function digestSchedule(ctx: Pick<Ctx, 'db' | 'cfg'>): Promise<DigestSchedule> {
  const r = await ctx.db.query<{ value: { enabled?: boolean; day?: number; hour?: number } }>("select value from app_settings where key='digest'");
  const o = r.rows[0]?.value;
  if (o && Number.isInteger(o.day) && Number.isInteger(o.hour)) {
    return { enabled: o.enabled !== false, day: o.day!, hour: o.hour!, source: 'admin' };
  }
  return { enabled: ctx.cfg.DIGEST_HOUR >= 0, day: ctx.cfg.DIGEST_DAY, hour: Math.max(0, ctx.cfg.DIGEST_HOUR), source: 'config' };
}

/** Latest local datetime <= now that falls on weekday `day` (0 = Sunday) at `hour`:00. */
export function slotFor(now: Date, day: number, hour: number): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour);
  d.setDate(d.getDate() - ((d.getDay() - day + 7) % 7));
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 7);
  return d;
}

/** Local calendar date of the slot, YYYY-MM-DD (the digests.week key). */
export function weekKey(slot: Date): string {
  return `${slot.getFullYear()}-${String(slot.getMonth() + 1).padStart(2, '0')}-${String(slot.getDate()).padStart(2, '0')}`;
}

/** Newest library items (as the account's own Jellyfin user sees them) created since `since`. */
async function newItems(ctx: Ctx, user: UserRow, since: Date, until: Date): Promise<ItemDto[]> {
  const out: ItemDto[] = [];
  for (let start = 0; start < SCAN_CAP; start += PAGE) {
    const page = await ctx.jf.addedItems(user, { start, limit: PAGE });
    let older = false;
    for (const i of page) {
      const t = i.dateCreated ? Date.parse(i.dateCreated) : NaN;
      if (Number.isNaN(t)) continue;
      if (t < since.getTime()) { older = true; continue; }
      if (t <= until.getTime()) out.push(i);
    }
    if (older || page.length < PAGE) break;
  }
  return out;
}

/** Builds the week's summary for one account; null when there is nothing to report. */
export async function buildDigest(ctx: Ctx, user: UserRow, since: Date, until: Date): Promise<DigestData | null> {
  const raw = await newItems(ctx, user, since, until);
  const movies = raw.filter((i) => i.type === 'Movie');
  const eps = raw.filter((i) => i.type === 'Episode' && i.seriesId);

  const followed = new Set((await ctx.db.query<{ series_id: string }>('select series_id from series_follows where user_id=$1', [user.id])).rows.map((r) => r.series_id));
  const nextUp = await ctx.jf.nextUp(user).catch(() => []);
  for (const n of nextUp) if (n.seriesId) followed.add(n.seriesId);

  const groups = new Map<string, DigestData['newEpisodes'][number]>();
  for (const e of eps) {
    let g = groups.get(e.seriesId!);
    if (!g) {
      g = { seriesId: e.seriesId!, seriesName: e.seriesName ?? '', count: 0, followed: followed.has(e.seriesId!), episodes: [] };
      groups.set(e.seriesId!, g);
    }
    g.count++;
    if (g.episodes.length < MAX_EPISODES_PER_SERIES) g.episodes.push({ id: e.id, name: e.name, season: e.parentIndexNumber, episode: e.indexNumber });
  }
  const sorted = [...groups.values()].sort((a, b) => Number(b.followed) - Number(a.followed) || b.count - a.count || a.seriesName.localeCompare(b.seriesName));
  const newEpisodes = sorted.slice(0, MAX_SERIES);

  const avail = (await ctx.db.query<{ title: string; body: string | null; link: string | null; msg: unknown }>(
    "select title, body, link, msg from notifications where user_id=$1 and kind in ('available','reminder') and created_at >= $2 and created_at <= $3 order by created_at desc limit 20",
    [user.id, since, until],
  )).rows;

  const recs = (await ctx.db.query<{ item_id: string; item_name: string; note: string | null; from_name: string }>(
    `select r.item_id, r.item_name, r.note, u.name as from_name from recommendations r join users u on u.id=r.from_user
      where r.to_user=$1 and r.created_at >= $2 and r.created_at <= $3 order by r.created_at desc limit $4`,
    [user.id, since, until, MAX_RECS],
  )).rows;
  const recommendations: DigestData['recommendations'] = recs.map((r) => ({ itemId: r.item_id, name: r.item_name, from: r.from_name, note: r.note, kind: 'recommended' }));
  if (recommendations.length < MAX_RECS) {
    const rated = (await ctx.db.query<{ item_id: string; item_name: string; names: string[] }>(
      `select r.item_id, max(r.item_name) as item_name, array_agg(u.name order by r.created_at desc) as names
         from ratings r join users u on u.id = r.user_id left join user_prefs p on p.user_id = r.user_id
        where r.user_id <> $1 and r.stars >= 4 and r.created_at >= $2 and r.created_at <= $3 and not u.disabled
          and coalesce((p.data->>'shareRatings')::boolean, true)
          and r.item_id not in (select item_id from ratings where user_id = $1)
        group by r.item_id order by max(r.created_at) desc limit $4`,
      [user.id, since, until, MAX_RECS],
    )).rows;
    const have = new Set(recommendations.map((r) => r.itemId));
    for (const r of rated) {
      if (recommendations.length >= MAX_RECS) break;
      if (have.has(r.item_id)) continue;
      recommendations.push({ itemId: r.item_id, name: r.item_name, from: r.names.slice(0, 2).join(', '), note: null, kind: 'friends' });
    }
  }

  const lang = await userLanguage(ctx, user.id);
  const data: DigestData = {
    since: since.toISOString(),
    until: until.toISOString(),
    newMovies: movies.slice(0, MAX_MOVIES).map((m) => ({ id: m.id, name: m.name, year: m.year })),
    newMovieCount: movies.length,
    movieIds: movies.slice(0, MAX_MOVIE_IDS).map((m) => m.id),
    newEpisodes,
    newEpisodeCount: eps.length,
    seriesCounts: Object.fromEntries(sorted.map((g) => [g.seriesId, g.count])),
    available: avail.map((a) => ({ title: localizeStored(a, lang).title, link: a.link, itemId: /^\/item\/([0-9a-f]{32})$/.exec(a.link ?? '')?.[1] ?? null })),
    recommendations,
  };
  if (!data.newMovieCount && !data.newEpisodeCount && !data.available.length && !data.recommendations.length) return null;
  return data;
}

/** "3 neue Filme, 5 neue Folgen" part of the headline */
function headline(d: DigestData): Text {
  const parts: Text[] = [];
  if (d.newMovieCount) parts.push(m('digest.movies', { n: d.newMovieCount }));
  if (d.newEpisodeCount) parts.push(m('digest.episodes', { n: d.newEpisodeCount }));
  return parts.length ? m('digest.titleWith', { parts: { join: parts, sep: ', ' } }) : m('digest.title');
}

const wishesAndRecs = (d: DigestData): Text[] => [
  ...(d.available.length ? [m('digest.wishes', { n: d.available.length })] : []),
  ...(d.recommendations.length ? [m('digest.recs', { n: d.recommendations.length })] : []),
];

/** In-app text: counts only (titles may be hidden for restricted profiles, so none appear in the inbox). Rendered per reader (i18n.ts). */
export function digestText(d: DigestData): { title: Text; body: Text } {
  const lines: Text[] = [];
  const nSeries = Object.keys(d.seriesCounts ?? {}).length || d.newEpisodes.length;
  const fol = d.newEpisodes.filter((g) => g.followed).length;
  if (d.newMovieCount) lines.push(m('digest.movies', { n: d.newMovieCount }));
  if (d.newEpisodeCount) {
    const eps = m('digest.episodesIn', { episodes: m('digest.episodes', { n: d.newEpisodeCount }), series: m('digest.series', { n: nSeries }) });
    lines.push(fol ? m('digest.ofYours', { text: eps, n: fol }) : eps);
  }
  lines.push(...wishesAndRecs(d));
  return { title: headline(d), body: { join: lines.slice(0, 5) } };
}

/** Personal ntfy text only (own topic): may name titles. */
export function digestPushText(d: DigestData): Text {
  const lines: Text[] = [];
  const names = (shown: string[], total: number): Text => (total > shown.length ? m('more', { list: shown.join(', '), n: total - shown.length }) : shown.join(', '));
  if (d.newMovieCount) lines.push(m('digest.pushMovies', { list: names(d.newMovies.slice(0, 3).map((x) => x.name), d.newMovieCount) }));
  const fol = d.newEpisodes.filter((g) => g.followed);
  const src = fol.length ? fol : d.newEpisodes;
  if (src.length) lines.push(m(fol.length ? 'digest.pushYourSeries' : 'digest.pushSeries', { list: names(src.slice(0, 3).map((g) => `${g.seriesName} (${g.count})`), src.length) }));
  lines.push(...wishesAndRecs(d));
  return { join: lines.slice(0, 5) };
}

export interface DigestWindow { key: string; since: Date; until: Date }

/** Builds, claims the (user, week) row and notifies. `test` skips the claim (admin preview) and uses a unique dedupe key. */
export async function sendDigest(ctx: Ctx, user: UserRow, w: DigestWindow, test = false): Promise<{ sent: boolean; data: DigestData | null }> {
  const data = await buildDigest(ctx, user, w.since, w.until);
  if (!data) return { sent: false, data: null };
  if (!test) {
    const claim = await ctx.db.query('insert into digests(user_id, week, data) values ($1,$2,$3) on conflict do nothing returning week', [user.id, w.key, JSON.stringify(data)]);
    if (!claim.rowCount) return { sent: false, data };
  }
  const { title, body } = digestText(data);
  const sent = await notify(ctx, {
    userId: user.id, kind: 'digest', title, body, pushBody: digestPushText(data), link: '/digest',
    dedupe: test ? `digest-test-${user.id}-${Date.now()}` : `digest-${user.id}-${w.key}`,
    personal: true, // own ntfy topic only, never the global channels
  });
  return { sent, data };
}

const busy = new WeakSet<Ctx>();
const empty = new Map<string, number>(); // "<user>-<week>" with nothing to report -> checked at: not re-queried on every tick
const RECHECK_MS = 2 * 3600_000;
/** Test hook: forget which accounts had an empty week. */
export function resetDigestState() { empty.clear(); }

/** Timer tick (every 10 min): inside the 24 h after the weekly slot, sends each opted-in account its digest once. */
export async function digestTick(ctx: Ctx, now = new Date()): Promise<number> {
  const s = await digestSchedule(ctx);
  if (!s.enabled || s.hour < 0 || busy.has(ctx)) return 0;
  const slot = slotFor(now, s.day, s.hour);
  if (now.getTime() - slot.getTime() > DAY_MS) return 0;
  const key = weekKey(slot);
  busy.add(ctx);
  let sent = 0;
  try {
    const users = (await ctx.db.query<UserRow>(
      `select u.* from users u left join user_prefs p on p.user_id = u.id
        where not u.disabled and coalesce(p.data->>'weeklyDigest', 'true') <> 'false'
          and not exists (select 1 from digests d where d.user_id = u.id and d.week = $1) order by u.created_at`,
      [key],
    )).rows;
    const window = { key, since: new Date(slot.getTime() - 7 * DAY_MS), until: now };
    for (const u of users) {
      const ek = `${u.id}-${key}`;
      if (now.getTime() - (empty.get(ek) ?? -Infinity) < RECHECK_MS) continue;
      try {
        const r = await sendDigest(ctx, u, window);
        if (r.sent) sent++;
        else if (!r.data) { empty.set(ek, now.getTime()); if (empty.size > 5000) empty.clear(); }
      } catch (e) {
        console.error('digest failed for', u.id, e);
      }
    }
  } finally {
    busy.delete(ctx);
  }
  return sent;
}
