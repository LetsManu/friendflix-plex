// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Block 17 D1 "Discovery": fresh labels ("Neue Folge", "Neue Staffel", "Staffelfinale", "Neue Serie", "Neu"), the "leaving soon"
 * dates admins set (badge, home row, notifications) and the quality index behind the browse filter 4K / HDR.
 * Everything here works on the neutral MediaServer interface; callers pass items the viewer is allowed to see (the visibility gate
 * is always a ctx.jf call with the viewer's own identity, never a cached answer for somebody else).
 */
import type { Ctx } from './ctx.js';
import { recordError } from './errorlog.js';
import { m } from './i18n.js';
import { MediaError, type ItemDto } from './media/types.js';
import { notify } from './notify.js';
import { jfUserFor, listProfiles } from './profiles.js';
import type { JfUser, UserRow } from './types.js';

const DAY = 86_400_000;

// ---------------------------------------------------------------- fresh labels

export type FreshLabel = 'newEpisode' | 'newSeason' | 'finale' | 'newSeries' | 'new';
/** one title is "new" for this long (library date or premiere) */
export const NEW_DAYS = 14;
/** an episode counts as "new episode" for this long */
export const NEW_EPISODE_DAYS = 7;
/** a season needs at least this many episodes before it can be a finale (a lone special is not) */
export const FINALE_MIN_EPISODES = 3;

const ms = (iso?: string): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};
/** within `days` before `now` (a little future tolerance for clock skew) */
const within = (t: number | null, now: number, days: number): boolean => t !== null && t <= now + DAY && now - t <= days * DAY;

/** What the label of a series needs from its (real, i.e. available) episodes. */
export interface EpisodeFacts { season: number; index: number; addedAt: number | null; premiere: number | null }

/** Movies: new in the library or premiered recently. */
export function movieLabel(item: Pick<ItemDto, 'dateCreated' | 'premiereDate'>, now: number): FreshLabel | null {
  return within(ms(item.dateCreated), now, NEW_DAYS) || within(ms(item.premiereDate), now, NEW_DAYS) ? 'new' : null;
}

/**
 * Series label, one at most, in this priority: the whole series is new -> "Neue Serie"; else the newest season is complete and its
 * last episode just arrived -> "Staffelfinale"; else the newest season started recently -> "Neue Staffel"; else an episode arrived
 * within a week -> "Neue Folge". `ended`: the series is not "continuing" (a continuing show may have more episodes coming, so only an
 * ended one can be called complete; announced-but-unaired episodes also block a finale).
 */
export function seriesLabel(
  item: Pick<ItemDto, 'dateCreated' | 'premiereDate'>, eps: EpisodeFacts[], opts: { ended: boolean; unaired: number }, now: number,
): FreshLabel | null {
  const arrived = (e: EpisodeFacts) => e.addedAt ?? e.premiere;
  if (within(ms(item.dateCreated), now, NEW_DAYS)) return 'newSeries';
  if (!eps.length) return within(ms(item.premiereDate), now, NEW_DAYS) ? 'newSeries' : null;
  const last = eps.reduce((a, e) => (e.season > a.season || (e.season === a.season && e.index > a.index) ? e : a));
  const season = eps.filter((e) => e.season === last.season);
  const first = season.reduce((a, e) => (e.index < a.index ? e : a));
  const lastRecent = within(arrived(last), now, NEW_EPISODE_DAYS) || within(last.premiere, now, NEW_EPISODE_DAYS);
  const seasonStartRecent = within(arrived(first), now, NEW_DAYS);
  // a season that arrived in one go is a new season, not a finale; a finale is the last episode of a season that began earlier
  if (lastRecent && !seasonStartRecent && opts.ended && opts.unaired === 0 && season.length >= FINALE_MIN_EPISODES) return 'finale';
  if (seasonStartRecent && last.season >= 2) return 'newSeason';
  if (lastRecent) return 'newEpisode';
  return null;
}

/** Facts for seriesLabel() from the ItemDto episodes (only real episodes are passed in). */
export const episodeFacts = (eps: ItemDto[]): EpisodeFacts[] =>
  eps.filter((e) => e.indexNumber != null).map((e) => ({ season: e.parentIndexNumber ?? 1, index: e.indexNumber!, addedAt: ms(e.dateCreated), premiere: ms(e.premiereDate) }));

const SERIES_TTL = 900;
/** at most this many uncached series (2 media-server calls each) are labelled per badges request; cached ones are free */
export const SERIES_LABELS_PER_REQUEST = 12;

/** Label of one series, cached for 15 min (the label depends on the library only, never on the viewer). */
async function labelForSeries(ctx: Pick<Ctx, 'kv' | 'jf'>, user: JfUser, item: ItemDto, continuing: Set<string> | null, now: number, budget: { left: number }): Promise<FreshLabel | null> {
  const key = `fresh:s:${item.id}`;
  const hit = await ctx.kv.get(key).catch(() => null);
  if (hit !== null && hit !== undefined) return hit === '' ? null : (hit as FreshLabel);
  if (budget.left <= 0) return null; // over this request's budget: no label now (a later request computes and caches it)
  budget.left--;
  const all = await ctx.jf.episodes(user, item.id);
  const real = all.length ? await ctx.jf.availableEpisodes(user, all.map((e) => e.id)) : new Set<string>();
  const have = all.filter((e) => real.has(e.id));
  const unaired = all.filter((e) => {
    const p = ms(e.premiereDate);
    return p !== null && p > now + DAY;
  }).length;
  const label = seriesLabel(item, episodeFacts(have), { ended: continuing ? !continuing.has(item.id) : false, unaired }, now);
  await ctx.kv.set(key, label ?? '', SERIES_TTL).catch(() => undefined);
  return label;
}

const CONT_PAGE = 500;
const CONT_MAX = 50_000;

/**
 * Ids of continuing series, cached 15 min. Library-wide via the admin-level `libraryContinuingSeriesIds` (paged through ALL of them:
 * a series missing from the set would be "ended" and could be called a finale). Servers without it fall back to the viewer's own
 * continuingSeries(), cached PER VIEWER (a restricted viewer's partial list must never decide for everybody else).
 * null = unknown (then a finale is never claimed).
 */
export async function continuingIds(ctx: Pick<Ctx, 'kv' | 'jf'>, user: JfUser): Promise<Set<string> | null> {
  const lib = ctx.jf.libraryContinuingSeriesIds?.bind(ctx.jf);
  const key = lib ? 'fresh:continuing:lib' : `fresh:continuing:u:${user.jellyfin_user_id}`;
  const hit = await ctx.kv.get(key).catch(() => null);
  if (hit) {
    try { return new Set(JSON.parse(hit) as string[]); } catch { /* recompute */ }
  }
  try {
    let ids: string[] = [];
    if (lib) {
      let complete = false;
      for (let start = 0; start < CONT_MAX; start += CONT_PAGE) {
        const page = await lib(start, CONT_PAGE);
        ids.push(...page);
        if (page.length < CONT_PAGE) { complete = true; break; }
      }
      if (!complete) return null; // absurdly large: better no finale than a wrong one
    } else {
      ids = (await ctx.jf.continuingSeries(user)).map((s) => s.item.id);
    }
    await ctx.kv.set(key, JSON.stringify(ids), SERIES_TTL).catch(() => undefined);
    return new Set(ids);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- leaving soon

/** the badge "Nur noch N Tage" shows this many days before the date; the home row reaches a bit further */
export const LEAVING_BADGE_DAYS = 14;
export const LEAVING_ROW_DAYS = 30;
/** notified this many days before (and on the last day / the day before) */
export const LEAVING_WEEK_DAYS = 7;

/**
 * "Today" of the instance as YYYY-MM-DD in the backend's time zone (`TZ`, compose default Europe/Vienna; UTC when unset). All
 * leaving-soon day counts use it instead of Postgres' current_date (the database container usually runs in UTC, which would
 * flip the count at 01:00/02:00 local time).
 */
export function instanceToday(now = new Date(), tz = process.env.TZ): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10); // unknown zone name: UTC
  }
}

export interface LeavingRow { item_id: string; leaves_at: string; note: string | null; days: number }

/** Days left (0 = last day) for each id that has a not yet expired date within `within` days. */
export async function leavingFor(ctx: Pick<Ctx, 'db'>, ids: string[], withinDays = LEAVING_BADGE_DAYS): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const r = await ctx.db.query<{ item_id: string; days: number }>(
    'select item_id, (leaves_at - $3::date)::int as days from leaving_soon where item_id = any($1) and leaves_at >= $3::date and leaves_at - $3::date <= $2',
    [ids, withinDays, instanceToday()],
  );
  return new Map(r.rows.map((x) => [x.item_id, x.days]));
}

export interface Badge { fresh?: FreshLabel; daysLeft?: number }

/**
 * Badges for cards. `items` are what the viewer may see (callers fetched them with the viewer's identity, so an invisible id simply
 * has no entry and reveals nothing). Episodes get no fresh label (their series' leaving date still applies).
 */
export async function badgesFor(ctx: Pick<Ctx, 'db' | 'kv' | 'jf'>, user: JfUser, items: ItemDto[], now = Date.now()): Promise<Record<string, Badge>> {
  const out: Record<string, Badge> = {};
  const leaving = await leavingFor(ctx, [...new Set(items.flatMap((i) => (i.type === 'Episode' && i.seriesId ? [i.seriesId] : [i.id])))]);
  const seriesTodo: ItemDto[] = [];
  for (const i of items) {
    const b: Badge = {};
    const d = leaving.get(i.type === 'Episode' && i.seriesId ? i.seriesId : i.id);
    if (d !== undefined) b.daysLeft = d;
    if (i.type === 'Movie') {
      const l = movieLabel(i, now);
      if (l) b.fresh = l;
    } else if (i.type === 'Series') {
      // cheap pre-check: nothing arrived lately -> no label, no episode lookup
      const touched = within(ms(i.lastAdded), now, NEW_DAYS) || within(ms(i.dateCreated), now, NEW_DAYS) || within(ms(i.premiereDate), now, NEW_DAYS);
      if (touched) seriesTodo.push(i);
    }
    if (b.fresh || b.daysLeft !== undefined) out[i.id] = b;
  }
  if (seriesTodo.length) {
    const continuing = await continuingIds(ctx, user);
    const budget = { left: SERIES_LABELS_PER_REQUEST };
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, seriesTodo.length) }, async () => {
      while (next < seriesTodo.length) {
        const s = seriesTodo[next++]!;
        try {
          const l = await labelForSeries(ctx, user, s, continuing, now, budget);
          if (l) out[s.id] = { ...out[s.id], fresh: l };
        } catch { /* no label this time */ }
      }
    }));
  }
  return out;
}

const notVisible = (e: unknown): boolean => e instanceof MediaError && (e.status === 404 || e.status === 403);

type Db = Pick<Ctx, 'db' | 'cfg' | 'fetchImpl' | 'jf' | 'kv'>;
let leavingBusy = false;

/**
 * Hourly: removes expired dates, then notifies (inbox, push, own ntfy topic) the accounts that have a leaving title on the watchlist or in
 * Continue Watching: once in the last week and once on the last two days. A notification goes to the account, and notifications are
 * visible on every profile except kids profiles, so it is only sent when EVERY non-kids profile of the account can see the title.
 */
export async function leavingTick(ctx: Db): Promise<number> {
  if (leavingBusy) return 0;
  leavingBusy = true;
  let sent = 0;
  try {
    const today = instanceToday();
    await ctx.db.query('delete from leaving_soon where leaves_at < $1::date', [today]);
    const due = (await ctx.db.query<LeavingRow>(
      `select item_id, leaves_at::text, note, (leaves_at - $2::date)::int as days from leaving_soon where leaves_at - $2::date <= $1 order by leaves_at`,
      [LEAVING_WEEK_DAYS, today],
    )).rows;
    if (!due.length) return 0;
    const users = (await ctx.db.query<UserRow>('select * from users where not disabled')).rows;
    const resumeCache = new Map<string, Set<string>>();
    const resumeIds = async (u: UserRow, profId: string, jf: JfUser): Promise<Set<string>> => {
      let s = resumeCache.get(profId);
      if (!s) {
        s = new Set((await ctx.jf.resume(jf)).flatMap((i) => [i.id, ...(i.seriesId ? [i.seriesId] : [])]));
        resumeCache.set(profId, s);
      }
      return s;
    };
    for (const u of users) {
      try {
        const profiles = (await listProfiles(ctx, u.id)).filter((p) => !p.kids);
        if (!profiles.length) continue;
        const own = new Set((await ctx.db.query<{ item_id: string }>(
          'select item_id from watchlist where profile_id = any($1) and item_id = any($2)', [profiles.map((p) => p.id), due.map((d) => d.item_id)])).rows.map((r) => r.item_id));
        for (const row of due) {
          let wants = own.has(row.item_id);
          for (const p of profiles) {
            if (wants) break;
            wants = (await resumeIds(u, p.id, jfUserFor(u, p)).catch(() => new Set<string>())).has(row.item_id);
          }
          if (!wants) continue;
          // every profile that will see the notification must be allowed to see the title
          let name: string | null = null;
          let visible = true;
          for (const p of profiles) {
            try {
              const it = await ctx.jf.item(jfUserFor(u, p), row.item_id);
              name ??= it.name;
            } catch (e) {
              if (notVisible(e)) { visible = false; break; }
              throw e;
            }
          }
          if (!visible || !name) continue;
          const stage = row.days <= 1 ? 'day' : 'week';
          const ok = await notify(ctx, {
            userId: u.id, kind: 'leaving',
            title: row.days <= 0 ? m('leaving.today', { title: name }) : m('leaving.days', { title: name, n: row.days }),
            body: m('leaving.body'), link: `/item/${row.item_id}`,
            dedupe: `leave-${stage}-${row.item_id}-${row.leaves_at}-${u.id}`, personal: true,
          });
          if (ok) sent++;
        }
      } catch (e) {
        console.warn('leaving notification failed', (e as Error).message);
      }
    }
  } finally {
    leavingBusy = false;
  }
  return sent;
}

// ---------------------------------------------------------------- quality index (browse filter 4K / HDR)

const INTERVAL_MS = 12 * 3600_000;
const PAGE = 200;
const MAX_MOVIES = 20_000;
const MAX_EPISODES = 100_000;
const QKEY = 'qualityidx:last';
let qBusy = false;
let qStarted = false;

const RES_RANK: Record<string, number> = { sd: 0, hd: 1, '4k': 2 };
const AUDIO_RANK: Record<string, number> = { mono: 0, stereo: 1, surround: 2, atmos: 3 };

/**
 * Rebuilds item_quality from the whole library (admin key sees everything): a movie by its own streams, a series by its best
 * episode. At most every 12 h (and once after start). Never throws; rows of vanished items go only after a complete run.
 * Servers without `libraryMediaTraits` leave the table empty (the browse chips then show nothing).
 */
export async function qualityIndexTick(ctx: Pick<Ctx, 'db' | 'kv' | 'jf'>, opts: { force?: boolean } = {}): Promise<void> {
  const scanFn = ctx.jf.libraryMediaTraits?.bind(ctx.jf);
  if (!scanFn || qBusy) return;
  qBusy = true;
  try {
    const last = Number(await ctx.kv.get(QKEY).catch(() => null)) || 0;
    if (!opts.force && Date.now() - last < INTERVAL_MS) {
      if (qStarted || (await ctx.db.query('select 1 from item_quality limit 1')).rowCount) return;
    }
    qStarted = true;
    const runStart = new Date();
    const agg = new Map<string, { type: 'Movie' | 'Series'; res: string; hdr: string | null; audio: string | null }>();
    const take = (id: string, type: 'Movie' | 'Series', t: { resolution: string; hdr: string | null; audio: string | null }) => {
      const a = agg.get(id);
      if (!a) { agg.set(id, { type, res: t.resolution, hdr: t.hdr, audio: t.audio }); return; }
      if ((RES_RANK[t.resolution] ?? 0) > (RES_RANK[a.res] ?? 0)) a.res = t.resolution;
      a.hdr ??= t.hdr;
      if (t.audio && (!a.audio || (AUDIO_RANK[t.audio] ?? 0) > (AUDIO_RANK[a.audio] ?? 0))) a.audio = t.audio;
    };
    const scan = async (type: 'Movie' | 'Episode', cap: number): Promise<boolean> => {
      for (let start = 0; start < cap; start += PAGE) {
        const n = Math.min(PAGE, cap - start);
        const page = await scanFn(type, start, n);
        for (const i of page) {
          if (type === 'Movie') take(i.id, 'Movie', i.traits);
          else if (i.seriesId) take(i.seriesId, 'Series', i.traits);
        }
        if (page.length < n) return true;
      }
      return false;
    };
    const moviesDone = await scan('Movie', MAX_MOVIES);
    const epsDone = await scan('Episode', MAX_EPISODES);
    const rows = [...agg.entries()];
    for (let i = 0; i < rows.length; i += 1000) {
      const b = rows.slice(i, i + 1000);
      await ctx.db.query(
        `insert into item_quality(item_id, type, res, hdr, audio, indexed_at)
         select id, t, r, nullif(h, ''), nullif(a, ''), $6 from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) as x(id, t, r, h, a)
         on conflict (item_id) do update set type = excluded.type, res = excluded.res, hdr = excluded.hdr, audio = excluded.audio, indexed_at = excluded.indexed_at`,
        [b.map((x) => x[0]), b.map((x) => x[1].type), b.map((x) => x[1].res), b.map((x) => x[1].hdr ?? ''), b.map((x) => x[1].audio ?? ''), runStart],
      );
    }
    if (moviesDone && epsDone) await ctx.db.query('delete from item_quality where indexed_at < $1', [runStart]);
    await ctx.kv.set(QKEY, String(Date.now()), 7 * 86400).catch(() => undefined);
  } catch (e) {
    console.warn('quality index failed', (e as Error).message);
    void recordError(ctx, { source: 'job', code: 'quality-index' });
  } finally {
    qBusy = false;
  }
}

// ---------------------------------------------------------------- "Story so far" (metadata only, no generated text)

/** A break this long (weeks) shows the card again, even within a season. */
export const STORY_BREAK_WEEKS = 6;

export interface Story {
  reason: 'newSeason' | 'longBreak';
  /** weeks since the viewer last watched this series (longBreak) */
  weeks?: number;
  /** overview of the last season the viewer completed */
  season?: { number: number; name: string; overview: string };
  /** the last episode the viewer watched */
  episode: { id: string; name: string; season: number; index: number; overview: string };
  /** the episode that comes next */
  next: { id: string; season: number; index: number };
}

const bySeasonEp = (a: ItemDto, b: ItemDto) => (a.parentIndexNumber ?? 0) - (b.parentIndexNumber ?? 0) || (a.indexNumber ?? 0) - (b.indexNumber ?? 0);

/**
 * The "Story so far" card: shown when the viewer starts a new season (the next unwatched episode opens a season after the last
 * watched one) or has not watched the series for STORY_BREAK_WEEKS. Only text the media server already has: the overview of the
 * last COMPLETED season (never a season the viewer is still in: that overview could spoil later episodes) and of the last watched
 * episode. null when there is nothing to show.
 */
export async function storySoFar(ctx: Pick<Ctx, 'jf'>, user: JfUser, seriesId: string, now = Date.now()): Promise<Story | null> {
  const eps = (await ctx.jf.episodes(user, seriesId)).filter((e) => e.indexNumber != null && (e.parentIndexNumber ?? 0) > 0).sort(bySeasonEp);
  const played = eps.filter((e) => e.played);
  if (!played.length) return null;
  const lastWatched = played.reduce((a, e) => ((ms(e.lastPlayedDate) ?? 0) >= (ms(a.lastPlayedDate) ?? 0) ? e : a));
  const next = eps.find((e) => !e.played && bySeasonEp(e, lastWatched) > 0) ?? eps.find((e) => !e.played);
  if (!next) return null;
  const firstOfSeason = eps.find((e) => e.parentIndexNumber === next.parentIndexNumber)!;
  const newSeason = next.id === firstOfSeason.id && (next.parentIndexNumber ?? 0) > (lastWatched.parentIndexNumber ?? 0);
  const at = ms(lastWatched.lastPlayedDate);
  const weeks = at !== null ? Math.floor((now - at) / (7 * DAY)) : 0;
  const longBreak = at !== null && weeks >= STORY_BREAK_WEEKS;
  if (!newSeason && !longBreak) return null;
  // last season the viewer finished: every episode played
  const seasonNums = [...new Set(eps.map((e) => e.parentIndexNumber ?? 0))].sort((a, b) => a - b);
  const done = seasonNums.filter((n) => n < (next.parentIndexNumber ?? 0)).filter((n) => eps.filter((e) => e.parentIndexNumber === n).every((e) => e.played));
  const doneNum = done.length ? done[done.length - 1]! : null;
  let season: Story['season'];
  if (doneNum !== null) {
    const s = (await ctx.jf.seasons(user, seriesId).catch(() => [] as ItemDto[])).find((x) => x.indexNumber === doneNum);
    if (s?.overview?.trim()) season = { number: doneNum, name: s.name, overview: s.overview.trim() };
  }
  const overview = lastWatched.overview?.trim() ?? '';
  if (!season && !overview) return null;
  return {
    reason: newSeason ? 'newSeason' : 'longBreak',
    ...(longBreak ? { weeks } : {}),
    ...(season ? { season } : {}),
    episode: { id: lastWatched.id, name: lastWatched.name, season: lastWatched.parentIndexNumber ?? 0, index: lastWatched.indexNumber ?? 0, overview },
    next: { id: next.id, season: next.parentIndexNumber ?? 0, index: next.indexNumber ?? 0 },
  };
}
