import { bus } from './bus.js';
import type { Ctx } from './ctx.js';
import { playbackHooks, seerrHooks } from './hooks.js';
import { m, type MsgKey, type Text } from './i18n.js';
import { CATALOGS } from './messages.js';
import { notify } from './notify.js';

interface Def {
  key: string;
  icon: string;
  title: string;
  desc: string;
  check: (ctx: Ctx, userId: string) => Promise<boolean>;
}

const one = async (ctx: Ctx, sql: string, p: unknown[]) => Number((await ctx.db.query<{ n: string }>(sql, p)).rows[0]?.n ?? 0);
const hours = (h: number) => async (ctx: Ctx, u: string) => (await one(ctx, 'select coalesce(sum(seconds),0) n from play_seconds where user_id=$1', [u])) >= h * 3600;

export const DEFS: Def[] = [
  { key: 'first_play', icon: 'film', title: 'Premiere', desc: 'Zum ersten Mal etwas geschaut', check: hours(0.0003) },
  { key: 'hours_10', icon: 'monitor', title: 'Couch-Potato', desc: '10 Stunden geschaut', check: hours(10) },
  { key: 'hours_50', icon: 'bar-chart', title: 'Serienjunkie', desc: '50 Stunden geschaut', check: hours(50) },
  { key: 'hours_100', icon: 'star', title: 'Kino-Legende', desc: '100 Stunden geschaut', check: hours(100) },
  { key: 'explorer', icon: 'search', title: 'Entdecker', desc: '25 verschiedene Titel geschaut', check: async (c, u) => (await one(c, 'select count(distinct coalesce(series_name,item_name)) n from play_seconds where user_id=$1', [u])) >= 25 },
  { key: 'binge', icon: 'shuffle', title: 'Binge-Watcher', desc: '3 Folgen derselben Serie an einem Tag', check: async (c, u) => (await one(c, `select count(*) n from (select series_name from play_seconds where user_id=$1 and series_name is not null and seconds >= 600 group by series_name, day having count(*) >= 3) x`, [u])) > 0 },
  { key: 'critic', icon: 'heart', title: 'Kritiker', desc: '5 Bewertungen abgegeben', check: async (c, u) => (await one(c, 'select count(*) n from ratings where user_id=$1', [u])) >= 5 },
  { key: 'wisher', icon: 'gift', title: 'Wunscherfüller', desc: 'Einen Titel gewünscht', check: async (c, u) => (await one(c, 'select count(*) n from seerr_requests where user_id=$1', [u])) >= 1 },
  { key: 'voter', icon: 'vote', title: 'Demokrat', desc: 'Bei einem Filmabend abgestimmt', check: async (c, u) => (await one(c, 'select count(*) n from poll_votes where user_id=$1', [u])) >= 1 },
  // event driven (granted directly)
  { key: 'party_goer', icon: 'users', title: 'Partylöwe', desc: 'Einer Watch-Party beigetreten', check: async () => false },
  { key: 'night_owl', icon: 'calendar', title: 'Nachteule', desc: 'Zwischen 1 und 4 Uhr nachts geschaut', check: async () => false },
];

/** Achievement name/description as a message (built-in keys) or the plain German text (unknown keys). */
const achText = (d: Def, part: 'title' | 'desc'): Text => {
  const key = `ach.${d.key}.${part}`;
  return key in CATALOGS.de ? m(key as MsgKey) : d[part];
};

export async function grant(ctx: Ctx, userId: string, key: string): Promise<boolean> {
  const d = DEFS.find((x) => x.key === key);
  if (!d) return false;
  const r = await ctx.db.query('insert into achievements(user_id,key) values ($1,$2) on conflict do nothing returning key', [userId, key]);
  if (!r.rowCount) return false;
  await notify(ctx, { userId, kind: 'achievement', title: m('achievement.unlocked', { name: achText(d, 'title') }), body: achText(d, 'desc'), link: '/stats', dedupe: `ach-${userId}-${key}` });
  return true;
}

/** Evaluates all state-based achievements for a user. */
export async function evaluate(ctx: Ctx, userId: string): Promise<string[]> {
  const have = new Set((await ctx.db.query<{ key: string }>('select key from achievements where user_id=$1', [userId])).rows.map((r) => r.key));
  const got: string[] = [];
  for (const d of DEFS) {
    if (have.has(d.key)) continue;
    if (await d.check(ctx, userId).catch(() => false)) {
      if (await grant(ctx, userId, d.key)) got.push(d.key);
    }
  }
  return got;
}

/** Wires playback statistics + achievement triggers. Called once from buildApp. */
let wired = false;
export function wireStats(ctx: Ctx) {
  if (wired) return;
  wired = true;
  playbackHooks.add(async (c, e) => {
    if (e.kind === 'Playing' || e.live.isPaused || e.elapsedMs <= 0) return;
    const seconds = Math.round(e.elapsedMs / 1000);
    if (seconds <= 0) return;
    await c.db.query(
      `insert into play_seconds(user_id,item_id,day,seconds,item_name,item_type,series_name) values ($1,$2,current_date,$3,$4,$5,$6)
       on conflict (user_id,item_id,day) do update set seconds = play_seconds.seconds + excluded.seconds`,
      [e.user.id, e.live.itemId, seconds, e.live.title, e.live.type ?? null, e.live.seriesName ?? null],
    );
    const hour = new Date().getHours();
    if (hour >= 1 && hour < 4) await grant(c, e.user.id, 'night_owl');
    // state-based checks are throttled to once per minute per user
    const key = `achcheck:${e.user.id}`;
    if (e.kind === 'Playing/Stopped' || !(await c.kv.get(key))) {
      await c.kv.set(key, '1', 60);
      await evaluate(c, e.user.id);
    }
  });
  bus.onT('party.join', ({ userId }) => void grant(ctx, userId, 'party_goer').catch(() => undefined));
  bus.onT('rating.created', ({ userId }) => void evaluate(ctx, userId).catch(() => undefined));
  seerrHooks.add(async (c, e) => {
    if (e.type === 'requested') await evaluate(c, e.user.id);
  });
}
