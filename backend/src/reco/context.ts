// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Ctx } from '../ctx.js';
import type { ItemDto } from '../media/types.js';
import type { RecoProfile, Taste } from './profile.js';
import type { FeatureRow } from './vectors.js';
import type { RecoCoefficients } from './weights.js';

/**
 * Recommendation engine v2, R3: context features (spec 2.3 item 2, 4.5). They are soft multipliers on the score, each within a few
 * percent, and the product is clamped to [context.min, context.max]: context never removes a title, it only nudges the order.
 *
 *  - time of day: how much the profile's own plays in this time bucket lean towards the title's genres (against its plays overall);
 *  - device class: short titles on phones, long ones on TVs, from the caller's device or the instance's device mix per time of day
 *    (playback_timings: anonymous start-time measurements, aggregated here);
 *  - language: the share of the profile's liked titles in the title's original language (the UI language when there is no history);
 *  - runtime against the time budget of the hour (late evening: shorter);
 *  - series status against the profile's drop behaviour (a profile that abandons series meets fewer unfinished ones).
 */

export type TimeBucket = 'morning' | 'afternoon' | 'evening' | 'night';
export const TIME_BUCKETS: readonly TimeBucket[] = ['morning', 'afternoon', 'evening', 'night'];
export type DeviceClass = 'phone' | 'pc' | 'tv';
export const DEVICE_CLASSES: readonly DeviceClass[] = ['phone', 'pc', 'tv'];

/** morning 5-11, afternoon 12-16, evening 17-22, night 23-4 */
export const timeBucket = (hour: number): TimeBucket => (hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 17 ? 'afternoon' : hour >= 17 && hour < 23 ? 'evening' : 'night');

const formatters = new Map<string, Intl.DateTimeFormat>();
/** Local hour (0-23) of a timestamp in the instance's time zone (`TZ`, UTC when unset or unknown). */
export function hourIn(ms: number, tz: string | undefined = process.env.TZ): number {
  const zone = tz || 'UTC';
  let f = formatters.get(zone);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }); } catch { f = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', hourCycle: 'h23' }); }
    formatters.set(zone, f);
  }
  return Number(f.format(new Date(ms))) % 24;
}

export interface RecoContext {
  /** local hour of the request */
  hour: number;
  /** the viewer's device class when the caller knows it (the player and the web app do; a plain API call may not) */
  device?: DeviceClass;
  /** share of playback starts per device class around this time of day, from the anonymous start-time measurements; null = too few */
  deviceMix?: Record<DeviceClass, number> | null;
  /** UI language of the profile (de, en ...) */
  uiLanguage?: string;
}

/** Minutes a viewer is assumed to have at this hour. */
export function timeBudget(hour: number, c: RecoCoefficients): number {
  const x = c.context;
  if (hour >= 23 || hour < 5) return x.budgetNight;
  if (hour >= 21) return x.budgetLate;
  if (hour >= 17) return x.budgetEvening;
  return x.budgetDay;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** -1..1: how well a runtime suits a device class. */
export function deviceFit(device: DeviceClass, runtimeMin: number): number {
  if (device === 'phone') return 1 - 2 * clamp((runtimeMin - 45) / 105, 0, 1); // <= 45 min +1, >= 150 min -1
  if (device === 'tv') return -0.5 + clamp((runtimeMin - 30) / 70, 0, 1); // <= 30 min -0.5, >= 100 min +0.5
  return 0;
}

export interface ContextParts { timeOfDay: number; device: number; language: number; runtime: number; status: number }
export interface ContextFit { factor: number; parts: ContextParts }

const NEUTRAL: ContextFit = { factor: 1, parts: { timeOfDay: 1, device: 1, language: 1, runtime: 1, status: 1 } };

/** Minutes per episode / film: the index row, else the media server's runtime. */
const runtimeMin = (item: Pick<ItemDto, 'runtimeTicks'>, row: Pick<FeatureRow, 'runtime_min'> | undefined): number | null =>
  row?.runtime_min ?? (item.runtimeTicks ? item.runtimeTicks / 6e8 : null);

/** The context multiplier of one title (all factors are 1 when the data for them is missing). */
export function contextFit(item: ItemDto, row: FeatureRow | undefined, taste: Pick<Taste, 'prefs'>, x: RecoContext, c: RecoCoefficients): ContextFit {
  const k = c.context;
  const p = { ...NEUTRAL.parts };
  const genres = row?.genres.length ? row.genres : item.genres.map((g) => g.trim().toLowerCase());

  // time of day: the profile's genre mix in this bucket against its mix overall (needs a few plays in the bucket)
  const tod = taste.prefs.timeOfDay;
  const bucket = timeBucket(x.hour);
  if (tod && genres.length && (tod.n[bucket] ?? 0) >= 5) {
    const mean = (m: Record<string, number> | undefined) => genres.reduce((s, g) => s + (m?.[g] ?? 0), 0) / genres.length;
    p.timeOfDay = 1 + k.timeOfDay * clamp((mean(tod.genres[bucket]) - mean(tod.overall)) * 2, -1, 1);
  }

  // device class
  const rt = runtimeMin(item, row);
  if (rt !== null) {
    const mix = x.device ? ({ phone: 0, pc: 0, tv: 0, [x.device]: 1 } as Record<DeviceClass, number>) : x.deviceMix ?? null;
    if (mix) p.device = 1 + k.device * DEVICE_CLASSES.reduce((s, d) => s + (mix[d] ?? 0) * deviceFit(d, rt), 0);
    // runtime against the time budget of the hour
    const budget = timeBudget(x.hour, c);
    if (rt > budget) p.runtime = 1 - k.runtime * clamp((rt - budget) / budget, 0, 1);
  }

  // language
  const lang = row?.original_language;
  if (lang) {
    const langs = taste.prefs.languages ?? {};
    const total = Object.values(langs).reduce((s, v) => s + v, 0);
    if (total > 0.2) p.language = 1 + k.language * (2 * clamp((langs[lang] ?? 0) / total, 0, 1) - 1);
    else if (x.uiLanguage) p.language = 1 + (lang === x.uiLanguage.toLowerCase() ? k.language / 2 : 0);
  }

  // series status against drop behaviour
  const drop = taste.prefs.dropRate;
  if (row?.type === 'Series' && row.series_status && drop !== null && drop !== undefined && drop >= c.context.dropRate) {
    const w = clamp(drop / 0.6, 0, 1);
    p.status = row.series_status === 'continuing' ? 1 - k.status * w : 1 + (k.status / 2) * w;
  }

  const factor = clamp(p.timeOfDay * p.device * p.language * p.runtime * p.status, k.min, k.max);
  return { factor, parts: p };
}

// ------------------------------------------------------------------------------------------------------------------------ loading

const MIX_KEY = 'reco:devmix:v1';
const MIX_TTL = 3600;
const MIX_MIN_SAMPLES = 30;

/**
 * Share of playback starts per device class for each time bucket over the last 14 days (the retention of playback_timings), as plain
 * counts per (bucket, device). The table is anonymous (no user, profile, item or address), so this is an aggregate of aggregates.
 * Cached for an hour. A bucket with fewer than 30 starts gives null (no signal).
 */
export async function deviceMixes(ctx: Pick<Ctx, 'db' | 'kv'>, tz: string | undefined = process.env.TZ): Promise<Record<TimeBucket, Record<DeviceClass, number> | null>> {
  const empty = { morning: null, afternoon: null, evening: null, night: null } as Record<TimeBucket, Record<DeviceClass, number> | null>;
  const hit = await ctx.kv.get(MIX_KEY).catch(() => null);
  if (hit) {
    try { return JSON.parse(hit) as typeof empty; } catch { /* rebuild */ }
  }
  let counts: Record<TimeBucket, Record<DeviceClass, number>>;
  try {
    const rows = (await ctx.db.query<{ device: DeviceClass; h: number; n: number }>(
      "select device, extract(hour from created_at at time zone $1)::int as h, count(*)::int as n from playback_timings where created_at > now() - interval '14 days' group by 1, 2", [tz || 'UTC'])).rows;
    counts = { morning: { phone: 0, pc: 0, tv: 0 }, afternoon: { phone: 0, pc: 0, tv: 0 }, evening: { phone: 0, pc: 0, tv: 0 }, night: { phone: 0, pc: 0, tv: 0 } };
    for (const r of rows) if (DEVICE_CLASSES.includes(r.device)) counts[timeBucket(Number(r.h))][r.device] += Number(r.n);
  } catch {
    return empty; // an unknown time zone name or a missing table: no device signal
  }
  const out = { ...empty };
  for (const b of TIME_BUCKETS) {
    const total = DEVICE_CLASSES.reduce((s, d) => s + counts[b][d], 0);
    if (total >= MIX_MIN_SAMPLES) out[b] = { phone: counts[b].phone / total, pc: counts[b].pc / total, tv: counts[b].tv / total };
  }
  await ctx.kv.set(MIX_KEY, JSON.stringify(out), MIX_TTL).catch(() => undefined);
  return out;
}

/** The context of a request: local hour, the profile's UI language, the instance's device mix for this time of day, and the caller's device if known. */
export async function contextFor(ctx: Pick<Ctx, 'db' | 'kv'>, profile: Pick<RecoProfile, 'id'>, now: number, device?: DeviceClass): Promise<RecoContext> {
  const hour = hourIn(now);
  const [mix, lang] = await Promise.all([
    deviceMixes(ctx).catch(() => null),
    ctx.db.query<{ l: string | null }>("select data->>'language' as l from profile_prefs where profile_id = $1", [profile.id]).then((r) => r.rows[0]?.l ?? undefined).catch(() => undefined),
  ]);
  return { hour, ...(device ? { device } : {}), deviceMix: mix?.[timeBucket(hour)] ?? null, ...(lang ? { uiLanguage: lang } : {}) };
}
