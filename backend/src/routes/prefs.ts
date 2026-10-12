import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { requireUser } from '../session.js';
import { LANGUAGES } from '../i18n.js';

export const prefsSchema = z.object({
  autoplayNext: z.boolean().default(true),
  autoSkipIntro: z.boolean().default(false),
  /** ISO 639-2 codes as Jellyfin reports them (ger, eng, ...); '' = keep the file's default */
  audioLang: z.string().regex(/^[a-z]{0,3}$/).default(''),
  /** '' = subtitles off by default */
  subtitleLang: z.string().regex(/^[a-z]{0,3}$/).default(''),
  /** friends may include my unwatched list in the group matcher (opt-in, default off) */
  shareHistory: z.boolean().default(false),
  /** my ratings may appear in "Freunde haben bewertet" (default on) */
  shareRatings: z.boolean().default(true),
  /** short muted trailer preview when hovering a card (only local trailers) */
  hoverTrailers: z.boolean().default(true),
  /** no local trailer? preview a short clip of the film itself (pre-generated once and cached as a plain MP4, so cheap) */
  hoverClip: z.boolean().default(true),
  /** detail view: once the preview has played long enough, start the title itself (countdown, desktop only) */
  autoStartPreview: z.boolean().default(true),
  /** 0 = automatic, else a bitrate in bit/s (capped by the role limit on the server) */
  quality: z.number().int().min(0).max(200_000_000).default(0),
  /** "Schaust du noch?" check before autoplaying further episodes */
  stillWatching: z.boolean().default(true),
  /** ask after this many episodes in a row without interaction */
  stillWatchingEpisodes: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).default(3),
  subtitleStyle: z.object({
    size: z.enum(['s', 'm', 'l', 'xl']).default('m'),
    color: z.enum(['white', 'yellow', 'cyan', 'green']).default('white'),
    background: z.enum(['none', 'shadow', 'semi', 'solid']).default('semi'),
    font: z.enum(['sans', 'serif', 'mono']).default('sans'),
  }).default({ size: 'm', color: 'white', background: 'semi', font: 'sans' }),
  /**
   * Anime (series with genre "Anime"): original (Japanese) audio with subtitles in the UI language, unless the series has its own
   * audio/subtitle preference (GET /api/series/:id/langpref). Per profile.
   */
  animeOriginal: z.boolean().default(false),
  /** blur thumbnails and hide descriptions of unwatched episodes */
  spoilerProtection: z.boolean().default(false),
  /** weekly "Wochenrückblick" (in-app + personal ntfy), account level */
  weeklyDigest: z.boolean().default(true),
  /** own ntfy topic for personal push messages ('' = off), account level */
  ntfyTopic: z.string().regex(/^[A-Za-z0-9_-]{0,64}$/).default(''),
  /** UI language of the profile ('' = never chosen: instance default applies and the first-login picker is shown) */
  language: z.enum(['', ...LANGUAGES]).default(''),
});
export type Prefs = z.infer<typeof prefsSchema>;

/** Account-level flags (stay in user_prefs, shared by all profiles); everything else is per profile (profile_prefs). */
const ACCOUNT_KEYS = ['shareHistory', 'shareRatings', 'weeklyDigest', 'ntfyTopic'] as const;

const pickAccount = (p: Prefs) => Object.fromEntries(ACCOUNT_KEYS.map((k) => [k, p[k]]));

/** Viewing prefs of a profile (default: the owner profile, whose id is the account id) merged with the account's share flags. */
export async function loadPrefs(ctx: Pick<Ctx, 'db'>, userId: string, profileId: string = userId): Promise<Prefs> {
  const r = await ctx.db.query<{ acc: Record<string, unknown> | null; prof: Record<string, unknown> | null }>(
    `select (select data from user_prefs where user_id=$1) acc,
            (select data from profile_prefs where profile_id=$2 and exists (select 1 from profiles where id=$2 and user_id=$1)) prof`,
    [userId, profileId],
  );
  const row = r.rows[0];
  const merged: Record<string, unknown> = { ...(row?.prof ?? {}) };
  for (const k of ACCOUNT_KEYS) if (row?.acc && k in row.acc) merged[k] = row.acc[k];
  const parsed = prefsSchema.safeParse(merged);
  return parsed.success ? parsed.data : prefsSchema.parse({});
}

/**
 * Onboarding flag `onboarded` in profile_prefs.data (set only by PUT /api/prefs/onboarded, kept by PUT /api/prefs; profiles older
 * than migration 31 have it). false: the profile never went through /welcome.
 */
export async function profileOnboarded(ctx: Pick<Ctx, 'db'>, profileId: string | undefined): Promise<boolean> {
  if (!profileId) return true;
  const r = await ctx.db.query<{ v: string | null }>("select data->>'onboarded' v from profile_prefs where profile_id=$1", [profileId]);
  return r.rows[0]?.v === 'true';
}

/** Topic (path) of the global NTFY_URL, or null. */
export function globalNtfyTopic(cfg: Pick<Ctx['cfg'], 'NTFY_URL'>): string | null {
  try {
    if (!cfg.NTFY_URL) return null;
    return decodeURIComponent(new URL(cfg.NTFY_URL).pathname).replace(/^\/+|\/+$/g, '') || null;
  } catch { return null; }
}

export function prefsRoutes(app: FastifyInstance, ctx: Ctx) {
  const pre = { preHandler: requireUser(ctx) };
  /** Account-level ntfy topic is a secret of the account: other profiles neither see nor change it. */
  const hideTopic = (req: { profile?: { is_owner: boolean } }, p: Prefs): Prefs => (req.profile!.is_owner ? p : { ...p, ntfyTopic: '' });
  app.get('/api/prefs', pre, async (req) => ({ prefs: hideTopic(req, await loadPrefs(ctx, req.user!.id, req.profile!.id)) }));
  app.put('/api/prefs', pre, async (req, reply) => {
    const input = prefsSchema.parse(req.body);
    // the global NTFY_URL topic is shared by everybody: a personal push to it would leak to all subscribers
    const g = globalNtfyTopic(ctx.cfg);
    if (input.ntfyTopic && g && input.ntfyTopic === g) return reply.code(400).send({ error: 'ntfy_topic_reserved' });
    // account flags are shared by all profiles: only the owner profile may change them (others keep the stored values)
    const stored = req.profile!.is_owner ? null : await loadPrefs(ctx, req.user!.id, req.profile!.id);
    let prefs: Prefs = stored ? { ...input, ...pickAccount(stored) } : input;
    // the language has its own endpoint (PUT /api/prefs/language): a full PUT without it (the web app never sends it) or
    // with '' must not reset or revert a choice made elsewhere (other tab/device, footer, first-login picker)
    if (!input.language) prefs = { ...prefs, language: (stored ?? await loadPrefs(ctx, req.user!.id, req.profile!.id)).language };
    const viewing: Record<string, unknown> = { ...prefs };
    for (const k of ACCOUNT_KEYS) delete viewing[k];
    // `onboarded` (stored next to the viewing prefs, not part of them) survives a full save: a settings form never brings /welcome back
    if (await profileOnboarded(ctx, req.profile!.id)) viewing.onboarded = true;
    // merged in SQL as well: a PUT /api/prefs/onboarded that lands between the read above and this write must not be lost
    await ctx.db.query(
      `insert into profile_prefs(profile_id, data) values ($1,$2) on conflict (profile_id) do update
         set data = excluded.data || case when profile_prefs.data->'onboarded' = 'true'::jsonb then '{"onboarded": true}'::jsonb else '{}'::jsonb end,
             updated_at = now()`,
      [req.profile!.id, JSON.stringify(viewing)],
    );
    if (!stored) {
      await ctx.db.query(
        `insert into user_prefs(user_id, data) values ($1,$2) on conflict (user_id) do update set data = excluded.data, updated_at = now()`,
        [req.user!.id, JSON.stringify(pickAccount(prefs))],
      );
    }
    return { prefs: hideTopic(req, prefs) };
  });
  /** Sets only the UI language of the active profile (first-login picker, footer, settings); every profile may set its own. */
  app.put('/api/prefs/language', pre, async (req) => {
    const { language } = z.object({ language: z.enum(LANGUAGES) }).parse(req.body);
    await ctx.db.query(
      `insert into profile_prefs(profile_id, data) values ($1, jsonb_build_object('language', $2::text))
       on conflict (profile_id) do update set data = profile_prefs.data || jsonb_build_object('language', $2::text), updated_at = now()`,
      [req.profile!.id, language],
    );
    return { language };
  });
  /** /welcome finished or skipped: the onboarding never shows again for this profile (kids profiles included). */
  app.put('/api/prefs/onboarded', { ...pre, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    z.object({ onboarded: z.literal(true) }).parse(req.body);
    await ctx.db.query(
      `insert into profile_prefs(profile_id, data) values ($1, '{"onboarded": true}'::jsonb)
       on conflict (profile_id) do update set data = profile_prefs.data || '{"onboarded": true}'::jsonb, updated_at = now()`,
      [req.profile!.id],
    );
    return { onboarded: true };
  });
}
