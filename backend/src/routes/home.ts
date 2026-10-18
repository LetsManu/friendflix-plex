// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../ctx.js';
import { isKidsProfile } from '../kids.js';
import type { ItemDto } from '../media/types.js';
import { homeGens } from '../homegen.js';
import { nextUpItems, resumeItems } from '../resumeRows.js';
import { countFallback, rankHomeRows, recoProfileOf, v2Active, type EngineName } from '../reco/engine.js';
import { requireUser } from '../session.js';
import type { JfUser } from '../types.js';
import { friendsRatedFor, leavingRow, libraryBecause, libraryBecauseMore, recommendationsFor } from './discover.js';
import { themedLists } from './lists.js';

/**
 * GET /api/home: the first screen of the home page in ONE request (hero, resume, next up, leaving, recommendations + friends,
 * because rows, brand hubs, themed lists). Every part comes from the same internal function as its own endpoint (those stay),
 * run as the viewer's Jellyfin user, so role libraries, age caps and kids profiles apply exactly as there. A failing part is
 * answered empty and named in `failed` (never a 500); such a response is not cached, the client reloads that part the old way.
 */

export const HOME_TTL = 60;

/** Hero pool of the home page billboard: the same query the client used to send to /api/library/items. */
const HERO_POOL = 15;

/** Billboard pick: the first of 15 random titles with a backdrop, else the first one (what the client chose before). */
async function heroItem(ctx: Ctx, jfUser: JfUser): Promise<ItemDto | null> {
  const pool = (await ctx.jf.items(jfUser, { types: 'Movie,Series', sort: 'Random', limit: HERO_POOL, desc: false })).items;
  return pool.find((i) => i.backdrop) ?? pool[0] ?? null;
}

export interface HomeParts {
  hero: ItemDto | null;
  resume: ItemDto[];
  nextup: ItemDto[];
  leaving: ItemDto[];
  /** recommendations from friends + friends' ratings (social: empty for kids profiles) */
  recs: { items: ItemDto[]; recIds: number[]; friends: ItemDto[] };
  /** main "Because you watched" row plus the extra rows */
  because: { because: { id: string; name: string; liked: boolean } | null; items: ItemDto[]; more: Array<{ because: { id: string; name: string }; items: ItemDto[]; engine?: EngineName }>; engine?: EngineName };
  /**
   * RECO_ENGINE=v2 only: the recommendation rows in the order the row ranker chose, as keys `friends`, `because`, `more:<n>` (n = index in
   * `because.more`). A row that is not listed was dropped (too small, or only titles the profile has seen). Absent = the web's fixed layout.
   */
  order?: string[];
  hubs: unknown[];
  themed: unknown[];
}
export interface HomeResponse { parts: HomeParts; failed: string[] }

const emptyParts = (): HomeParts => ({
  hero: null, resume: [], nextup: [], leaving: [],
  recs: { items: [], recIds: [], friends: [] },
  because: { because: null, items: [], more: [] },
  hubs: [], themed: [],
});

export function homeRoutes(app: FastifyInstance, ctx: Ctx, hubs: { viewerHubs: (u: JfUser) => Promise<{ hubs: unknown[] }> }) {
  const pre = { preHandler: requireUser(ctx) };

  async function build(req: Parameters<typeof isKidsProfile>[0] & { jfUser?: JfUser; user?: { id: string }; profile?: { id: string } }): Promise<HomeResponse> {
    const jf = req.jfUser!, userId = req.user!.id, profileId = req.profile!.id;
    const kids = isKidsProfile(req);
    const parts = emptyParts();
    const failed: string[] = [];
    const part = async (name: keyof HomeParts, run: () => Promise<void>) => {
      try { await run(); } catch { failed.push(name); }
    };
    await Promise.all([
      part('hero', async () => { parts.hero = await heroItem(ctx, jf); }),
      part('resume', async () => { parts.resume = await resumeItems(ctx, jf, profileId); }),
      part('nextup', async () => { parts.nextup = await nextUpItems(ctx, jf, profileId); }),
      part('leaving', async () => { parts.leaving = (await leavingRow(ctx, jf)).items; }),
      // recommendations and friends' ratings are social: a kids profile gets neither (they answer 403 kids_profile on their own routes)
      part('recs', async () => {
        if (kids) return;
        const [r, f] = await Promise.all([recommendationsFor(ctx, jf, userId), friendsRatedFor(ctx, jf, userId, profileId)]);
        parts.recs = { items: r.items, recIds: r.recIds, friends: f.items };
      }),
      part('because', async () => {
        const [main, more] = await Promise.all([libraryBecause(ctx, jf, profileId), libraryBecauseMore(ctx, jf, profileId).then((r) => r.rows)]);
        parts.because = { because: main.because, items: main.items, more, ...(main.engine ? { engine: main.engine } : {}) };
      }),
      part('hubs', async () => { parts.hubs = (await hubs.viewerHubs(jf)).hubs; }),
      part('themed', async () => { parts.themed = (await themedLists(ctx, jf, kids)).lists; }),
    ]);
    if (v2Active(ctx.cfg) && !failed.includes('because') && !failed.includes('recs')) await orderRows(jf, profileId, parts);
    return { parts, failed: failed.sort() };
  }

  /** RECO_ENGINE=v2: the row ranker orders and cleans the recommendation rows; on any error the fixed layout stays (counted as a fallback). */
  async function orderRows(jf: JfUser, profileId: string, parts: HomeParts): Promise<void> {
    try {
      const profile = await recoProfileOf(ctx, profileId);
      if (!profile) return;
      const more = parts.because.more;
      const ranked = await rankHomeRows(ctx, jf, profile, [
        { key: 'friends', kind: 'friends', items: parts.recs.friends },
        { key: 'because', kind: 'because', items: parts.because.items },
        ...more.map((r, n) => ({ key: `more:${n}`, kind: 'because_more' as const, items: r.items })),
      ]);
      const by = new Map(ranked.map((r) => [r.key, r.items]));
      parts.recs.friends = by.get('friends') ?? [];
      parts.because.items = by.get('because') ?? [];
      parts.because.more = more.map((r, n) => ({ ...r, items: by.get(`more:${n}`) ?? [] }));
      parts.order = ranked.map((r) => r.key);
    } catch {
      countFallback('home');
    }
  }

  app.get('/api/home', pre, async (req) => {
    // the key carries the user-data version (bumped by every played / favorite / progress write) and the generation counters (see
    // homegen.ts: hidden resume entries, status, thumbs, ratings, admin edits), so those changes show at once
    const pid = req.profile!.id;
    const [ver, gens] = await Promise.all([ctx.jf.userDataVersion(req.jfUser!).catch(() => '0'), homeGens(ctx, pid)]);
    // ... and the engine (RECO_ENGINE is a live setting: a switch in Admin -> Settings must not serve the other engine's cached rows)
    const key = `home:${pid}:${ver}:${gens}:${ctx.cfg.RECO_ENGINE}`;
    const hit = await ctx.kv.get(key).catch(() => null);
    if (hit) {
      try { return JSON.parse(hit) as HomeResponse; } catch { /* corrupt entry: recompute */ }
    }
    const out = await build(req);
    if (!out.failed.length) await ctx.kv.set(key, JSON.stringify(out), HOME_TTL).catch(() => undefined);
    return out;
  });
}
