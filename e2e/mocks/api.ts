import type { BrowserContext, Route } from '@playwright/test';
import { ME, byName, episodes, hex, items, nolan, people, seedLists, type MockItem, type MockList, MOVIE, MOVIE2, SERIES } from './fixtures.js';
import { pngFor } from './png.js';
import { adminRoute, adminState, type AdminState } from './admin.js';

/** Item whose reactions are locked (viewer has not seen it) / unlocked and contain an XSS probe. */
export const LOCKED_ID = MOVIE.id;
export const UNLOCKED_ID = MOVIE2.id;
export const XSS_COMMENT = '<b>x</b><img src=x onerror=alert(1)>';

export interface MockState {
  lists: MockList[];
  watch: Set<string>;
  dropped: Set<string>;
  fav: Set<string>;
  /** non-GET calls, "METHOD /path body -> status" */
  log: string[];
  /** GET/other API paths no handler matched (answered with {items: []}) */
  unmocked: Set<string>;
  /** payloads POSTed to /api/client-errors */
  clientErrors: unknown[];
  /** admin endpoints (mocks/admin.ts) */
  admin: AdminState;
  /** /api/me reports an admin owner profile (admin pages, admin menu) */
  asAdmin: boolean;
  /** ids removed from Weiterschauen (DELETE /api/library/resume/:id), left out of GET /api/library/resume */
  resumeGone: Set<string>;
  /** the profile's player sound pref (PUT /api/prefs/audiofx), echoed by GET /api/prefs */
  audioFx?: string;
}

export function freshState(): MockState {
  return {
    lists: seedLists(),
    watch: new Set([items[1]!.id, items[4]!.id, items[9]!.id, items[0]!.id]),
    dropped: new Set([items[3]!.id, items[10]!.id]),
    fav: new Set(items.filter((i) => i.favorite).map((i) => i.id)),
    log: [],
    unmocked: new Set(),
    clientErrors: [],
    admin: adminState(),
    asAdmin: false,
    resumeGone: new Set(),
  };
}

/** profile list for tests that switch /api/me to several profiles (profileCount: 3) */
export const PROFILES = [
  { id: 'p1', name: 'Tester', avatar: 'a1', isOwner: true, hasPin: false, active: true },
  { id: 'p2', name: 'Anna', avatar: 'a2', isOwner: false, hasPin: false, active: false },
  { id: 'p3', name: 'Ben', avatar: 'a3', isOwner: false, hasPin: false, active: false },
];

const find = (id: string): MockItem | undefined => [...items, ...episodes].find((i) => i.id === id);

/** Fully mocks `/api/**` and `/media/**` for a browser context. The web app is a pure SPA (ssr = false), so nothing else is needed. */
export async function installApi(ctx: BrowserContext, st: MockState): Promise<void> {
  await ctx.route('**/media/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: pngFor(r.request().url()) }));
  await ctx.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const m = req.method();
    const sp = u.searchParams;
    const body = (): any => { try { return JSON.parse(req.postData() || '{}'); } catch { return {}; } };
    const J = (b: unknown, status = 200) => {
      if (m !== 'GET') st.log.push(`${m} ${p} ${req.postData() ?? ''} -> ${status}`);
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    };
    const withFav = (i: MockItem) => ({ ...i, favorite: st.fav.has(i.id) });
    let mm: RegExpMatchArray | null;

    // Task 7 (Block 20): GET /api/home. The mock composes it from the single-endpoint mocks by fetching them inside the page (header
    // x-mock-sub, so specs can tell them from the app's own calls): every spec that mocks one of those endpoints keeps working.
    if (p === '/api/home' && m === 'GET') {
      const urls = {
        hero: '/api/library/items?types=Movie,Series&sort=Random&limit=15', resume: '/api/library/resume', nextup: '/api/library/nextup', leaving: '/api/library/leaving',
        recs: '/api/recommendations', friends: '/api/library/friends-rated', because: '/api/library/because', more: '/api/library/because-more', hubs: '/api/hubs', themed: '/api/lists/themed',
      };
      let got: Record<string, any> = {};
      try {
        got = await req.frame().evaluate(async (u) => Object.fromEntries(await Promise.all(Object.entries(u).map(async ([k, url]) => {
          try { const r = await fetch(url, { headers: { 'x-mock-sub': '1' } }); return [k, r.ok ? await r.json() : null]; } catch { return [k, null]; }
        }))), urls);
      } catch { /* page gone: everything counts as failed */ }
      const failed = new Set<string>();
      const need = (part: string, ...v: unknown[]) => { if (v.some((x) => !x)) failed.add(part); };
      need('hero', got.hero); need('resume', got.resume); need('nextup', got.nextup); need('leaving', got.leaving); need('recs', got.recs, got.friends);
      need('because', got.because, got.more); need('hubs', got.hubs); need('themed', got.themed);
      const pool: MockItem[] = got.hero?.items ?? [];
      return J({
        parts: {
          hero: pool.find((i) => i.backdrop) ?? pool[0] ?? null, resume: got.resume?.items ?? [], nextup: got.nextup?.items ?? [], leaving: got.leaving?.items ?? [],
          recs: { items: got.recs?.items ?? [], recIds: got.recs?.recIds ?? [], friends: got.friends?.items ?? [] },
          because: { because: got.because?.because ?? null, items: got.because?.items ?? [], more: got.more?.rows ?? [] },
          hubs: got.hubs?.hubs ?? [], themed: got.themed?.lists ?? [],
        },
        failed: [...failed].sort(),
      });
    }
    if (p === '/api/client-errors') { st.clientErrors.push(body()); return route.fulfill({ status: 204 }); }
    if (p === '/api/me') return J(st.asAdmin ? { ...ME, role: 'admin', roleLabel: 'Admin', isAdmin: true } : ME);
    if (p === '/api/notifications') return J({ notifications: [{ id: 'n1', title: 'Anna hat dich zur Liste „Annas Klassiker“ eingeladen', link: '/lists/' + st.lists[1]!.id, read: false }] });
    if (p === '/api/notifications/read') return J({ ok: true });
    if (p === '/api/prefs') return J({ prefs: st.audioFx ? { audioFx: st.audioFx } : {} });
    if (p === '/api/prefs/audiofx' && m === 'PUT') { st.audioFx = body().audioFx; return J({ audioFx: st.audioFx }); }
    if (p === '/api/push/config') return J({ enabled: false }); // settings page: push not set up on the mock server
    // UI language (block 14): profile language + admin instance default
    if (p === '/api/prefs/language' && m === 'PUT') return J({ language: body().language });
    if (p === '/api/admin/settings/language') return J(m === 'PUT' ? { language: body().language, set: true } : { language: 'de', set: true, languages: ['de', 'en', 'fr', 'es', 'it', 'tr', 'pl'] });
    if (p === '/api/watchlist/ids') return J({ ids: [...st.watch] });
    if (p === '/api/watchlist') return J({ items: [...st.watch].map(find).filter(Boolean).map((i) => withFav(i!)) });
    if (p === '/api/dropped') return J({ items: [...st.dropped].map(find).filter(Boolean) });
    if (p === '/api/library/resume') return J({ items: [episodes[0], items[2]].filter((i) => !st.resumeGone.has(i!.id)) });
    if ((mm = p.match(/^\/api\/library\/resume\/([^/]+)$/)) && m === 'DELETE') { st.resumeGone.add(mm[1]!); return J({ ok: true }); }
    if (p === '/api/library/nextup') return J({ items: [episodes[1]] });
    if (p === '/api/library/because') return J({ because: { name: 'Inkwell' }, items: items.slice(1, 12) });
    if (p === '/api/library/because-more') return J({ rows: [] }); // specs that need the extra "Weil du ..." rows mock it themselves
    if (p === '/api/recommendations') return J({ items: items.slice(5, 10) });
    if (p === '/api/library/friends-rated') return J({ items: items.slice(2, 8) });
    if (p === '/api/library/trending') {
      const ago = new Date(Date.now() - 3 * 864e5).toISOString();
      return J({ items: [{ ...items[0], viewers: 4 }, { ...items[8], lastAdded: ago, unplayedCount: 4, childCount: 2, playedPercentage: 30, viewers: 3 }, { ...items[1], viewers: 3 }, { ...items[2], viewers: 2 }, { ...items[5], viewers: 2 }] });
    }
    if (p === '/api/library/views') return J({ items: [{ id: hex(900), name: 'Filme' }, { id: hex(901), name: 'Serien' }] });
    if (p === '/api/library/genres') return J({ genres: ['Action', 'Drama', 'Krimi', 'Sci-Fi', 'Thriller'] });
    if (p === '/api/library/languages') return J({ audio: [{ code: 'deu', count: 10 }, { code: 'eng', count: 8 }, { code: 'jpn', count: 3 }], subs: [{ code: 'deu', count: 9 }, { code: 'eng', count: 7 }] });
    if (p === '/api/library/collections') return J({ items: [], studios: ['Wardell', 'Aster 9'] });
    if (p === '/api/library/random') return J({ item: items[0] });
    if (p === '/api/library/items') {
      let l = items;
      const t = sp.get('types');
      if (t && t !== 'Movie,Series') l = l.filter((i) => t.split(',').includes(i.type));
      const g = sp.get('genre');
      if (g) l = l.filter((i) => i.genres.includes(g));
      if (!l.length) l = items.slice(0, 4);
      const out = l;
      return J({ items: out.map(withFav), total: out.length });
    }
    if (p === '/api/search') {
      const q = (sp.get('q') || '').toLowerCase();
      if (q.includes('nolan')) return J({ q, titles: nolan, episodes: [], people: [{ id: hex(300), name: 'Carl Norden', image: true }, { id: hex(305), name: 'Jon Norden', image: false }], genres: [], partial: false });
      const titles = items.filter((i) => i.name.toLowerCase().includes(q));
      return J({ q, titles, episodes: q.includes('break') ? episodes.slice(0, 3) : [], people: [], genres: q.startsWith('dra') ? ['Drama'] : [], partial: false });
    }
    if ((mm = p.match(/^\/api\/people\/(.+)$/))) return J({ person: { id: mm[1], name: 'Carl Norden', overview: 'Britisch-amerikanischer Regisseur.', birthYear: 1970, image: true }, items: nolan });
    if (p === '/api/friends') return J({ friends: [{ id: 'u2', name: 'Anna', sharesHistory: true }, { id: 'u3', name: 'Ben', sharesHistory: false }] });
    if (p === '/api/seerr/search') return J({ results: [] });
    if (p === '/api/seerr/upcoming') return J({ results: [] });
    if (p === '/api/requests/quota') return J({ limit: 5, used: 1, remaining: 4, resetsAt: '2026-11-01T00:00:00Z' });
    if (p === '/api/requests/mine') return J({ requests: [] });
    if (p === '/api/reminders' || p === '/api/reminders/keys') return J(p.endsWith('keys') ? { keys: {} } : { reminders: [] });
    if (p === '/api/tv/status') return J({ tvOnline: false });
    // public pages (block 14 fixes): invite landing page and TV pairing carry the instance default language
    if ((mm = p.match(/^\/api\/invite\/([^/]+)$/))) {
      if (mm[1] === 'expired') return J({ error: 'invalid_or_expired' }, 404);
      const lang = sp.get('lang') || 'en';
      return J({ defaultLanguage: 'en', role: 'guest', roleLabel: ({ de: 'Gast', en: 'Guest', fr: 'Invité' } as Record<string, string>)[lang] ?? 'Gast', expiresAt: '2026-12-01T18:00:00Z' });
    }
    if (p === '/api/tv/code') return J({ code: 'ABCD-EFGH', pollToken: 'p'.repeat(32), expiresIn: 600, defaultLanguage: 'en' });
    if (p === '/api/tv/claim') return J({ status: 'pending' }, 202);
    // block 15: per-series audio/subtitle choice (+ anime flag), simulcast, onboarding flag
    if (/^\/api\/series\/[^/]+\/langpref$/.test(p)) return J({ audio: null, subtitle: null, ...(sp.get('anime') === '1' ? { anime: false } : {}) });
    if (p === '/api/simulcast') return J({ season: 'fall', year: 2026, total: 0, anime: sp.get('anime') === '1', days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, items: [] })) });
    if (p === '/api/prefs/onboarded' && m === 'PUT') return J({ onboarded: true });
    if (p.startsWith('/api/series/')) return J({ followed: false });

    // ----- lists -----
    if (p === '/api/lists/featured') return J({ lists: [] });
    // Block 17 S1: themed lists = the lists marked `themed`; the pinned ones are the home rows (order = array order)
    if (p === '/api/lists/themed') return J({ lists: st.lists.filter((l) => l.themed && l.pinned && l.items.length).map((l) => ({ id: l.id, name: l.name, description: l.description, emoji: l.emoji ?? null, coverColor: l.coverColor ?? null, owner: { name: l.owner.name }, items: l.items.map(find).filter(Boolean) })) });
    if (p === '/api/lists/themed/manage') return J({ max: 5, lists: st.lists.filter((l) => l.themed).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))).map((l) => ({ id: l.id, name: l.name, emoji: l.emoji ?? null, owner: { name: l.owner.name }, itemCount: l.items.length, pinned: Boolean(l.pinned) })) });
    if (p === '/api/lists/themed/order' && m === 'PUT') {
      const ids: string[] = body().ids;
      const pinned = st.lists.filter((l) => l.pinned).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      st.lists = [...pinned, ...st.lists.filter((l) => !l.pinned)];
      return J({ ok: true });
    }
    if ((mm = p.match(/^\/api\/lists\/([^/]+)\/pin$/)) && m === 'PUT') {
      const l = st.lists.find((x) => x.id === mm![1]);
      if (!l) return J({ error: 'not_found' }, 404);
      l.pinned = Boolean(body().pinned);
      return J({ ok: true, pinned: l.pinned });
    }
    if (p === '/api/lists' && m === 'GET') {
      return J({ lists: st.lists.map((l) => ({ id: l.id, name: l.name, description: l.description, owner: l.owner, role: l.role, itemCount: l.items.length, memberCount: l.members.length + 1, updatedAt: new Date().toISOString(), coverIds: l.items.slice(0, 4) })) });
    }
    if ((mm = p.match(/^\/api\/lists\/([^/]+)$/)) && m === 'GET') {
      const l = st.lists.find((x) => x.id === mm![1]);
      if (!l) return J({ error: 'not_found' }, 404);
      return J({ list: { id: l.id, name: l.name, description: l.description, owner: l.owner, role: l.role, themed: Boolean(l.themed), emoji: l.emoji ?? null, coverColor: l.coverColor ?? null, pinned: Boolean(l.pinned) }, members: [{ id: l.owner.id, name: l.owner.name, role: 'owner' }, ...l.members], items: l.items.map(find).map((i) => ({ ...i, addedBy: { id: 'u2', name: 'Anna' }, addedAt: new Date().toISOString(), note: null })), hiddenCount: 0 });
    }
    if ((mm = p.match(/^\/api\/lists\/([^/]+)$/)) && m === 'PATCH') {
      const l = st.lists.find((x) => x.id === mm![1]);
      if (!l) return J({ error: 'not_found' }, 404);
      const b = body();
      if (b.name !== undefined) l.name = b.name;
      if (b.description !== undefined) l.description = b.description;
      if (b.themed !== undefined) l.themed = b.themed;
      if (b.emoji !== undefined) l.emoji = b.emoji;
      if (b.coverColor !== undefined) l.coverColor = b.coverColor;
      return J({ ok: true });
    }
    if ((mm = p.match(/^\/api\/lists\/([^/]+)\/items$/)) && m === 'POST') {
      const l = st.lists.find((x) => x.id === mm![1]);
      const b = body();
      if (!l) return J({ error: 'not_found' }, 404);
      if (l.items.includes(b.itemId)) return J({ error: 'exists' }, 409);
      l.items.unshift(b.itemId);
      return J({ ok: true, itemId: b.itemId });
    }
    if ((mm = p.match(/^\/api\/lists\/([^/]+)\/items\/([^/]+)$/)) && m === 'DELETE') {
      const l = st.lists.find((x) => x.id === mm![1]);
      if (l) l.items = l.items.filter((x) => x !== mm![2]);
      return J({ ok: true });
    }
    if ((mm = p.match(/^\/api\/items\/([^/]+)\/lists$/))) {
      return J({ lists: st.lists.filter((l) => l.role === 'owner' || l.role === 'editor').map((l) => ({ id: l.id, name: l.name, contains: l.items.includes(mm![1]!), canEdit: true })) });
    }

    // ----- item actions + sub-resources -----
    if ((mm = p.match(/^\/api\/items\/([^/]+)\/watchlist$/))) {
      if (m === 'POST') { st.watch.add(mm[1]!); st.dropped.delete(mm[1]!); } else st.watch.delete(mm[1]!);
      return J({ ok: true });
    }
    if ((mm = p.match(/^\/api\/items\/([^/]+)\/status$/))) {
      const id = mm[1]!;
      if (m === 'GET') return J({ status: st.dropped.has(id) ? 'dropped' : st.watch.has(id) ? 'planned' : 'none' });
      const w = body().status;
      st.watch.delete(id); st.dropped.delete(id);
      if (w === 'planned') st.watch.add(id);
      if (w === 'dropped') st.dropped.add(id);
      return J({ status: w });
    }
    if ((mm = p.match(/^\/api\/items\/([^/]+)\/favorite$/))) { if (m === 'POST') st.fav.add(mm[1]!); else st.fav.delete(mm[1]!); return J({ ok: true }); }
    if ((mm = p.match(/^\/api\/items\/([^/]+)\/(played|thumb)$/))) return J({ ok: true });
    // Block 17 D1 (discovery) defaults = nothing to show; specs that exercise badges / removal dates / quality chips mock them themselves
    if (p === '/api/discover/badges') return J({}); // no `badges` key = an older server: cards keep the client-side "Neue Folgen" / "Neu" hints
    if (/^\/api\/items\/[^/]+\/facts$/.test(p)) return J({ fresh: null, leaving: null, traits: null });
    if (/^\/api\/items\/[^/]+\/story$/.test(p)) return J({ story: null });
    if (p === '/api/library/leaving') return J({ items: [] });
    if (/^\/api\/items\/[^/]+\/extras\/all$/.test(p)) return J({ items: [] }); // Extras tab (block 15): specs with extras mock it themselves
    // Block 17 P1 (player): no chapters / no cast by default; player-scenes specs mock both themselves
    if (/^\/api\/items\/[^/]+\/chapters$/.test(p)) return J({ supported: true, chapters: [] });
    if (/^\/api\/items\/[^/]+\/castinfo$/.test(p)) return J({ item: { id: p.split('/')[3], name: '', type: 'Movie' }, cast: [], guests: [], directors: [], writers: [], creators: [], studios: [], genres: [], tags: [] });
    if (p === '/api/hubs') return J({ hubs: [] }); // brand hub tiles (block 15): specs with hubs mock it themselves
    if ((mm = p.match(/^\/api\/items\/([^/]+)\/reactions$/))) {
      if (mm[1] === LOCKED_ID && m === 'GET') return J({ locked: true, count: 3 });
      const now = new Date().toISOString();
      return J({
        locked: false, count: 2, summary: { like: 1, funny: 0, wow: 1, sad: 0, love: 0 },
        reactions: [{ name: 'Anna', emoji: 'like', comment: XSS_COMMENT, mine: false, createdAt: now }, { name: 'Tester', emoji: 'wow', comment: 'Mein Kommentar', mine: true, createdAt: now }],
      });
    }
    if ((mm = p.match(/^\/api\/items\/([^/]+)\/(\w+)$/))) {
      switch (mm[2]) {
        case 'friends': return J({ friends: [{ id: 'f1', name: 'Anna Beispiel', stars: 5, watched: true, recommended: true }, { id: 'f2', name: 'Ben Test', stars: 4, watched: true }] });
        case 'people': return J({ people });
        case 'ratings': return J({ ratings: [{ userId: 'f1', name: 'Anna', stars: 5, review: 'Super!', mine: false }], average: 4.5 });
        case 'similar': return J({ items: items.slice(0, 8) });
        case 'extras': return J({ items: [] });
        case 'comments': return J(m === 'POST' ? { id: 'c1', name: 'Tester', mine: true, spoiler: false, body: body().body, createdAt: new Date().toISOString(), canDelete: true } : { watched: true, comments: [] }); // episode comments (block 15)
        case 'seasons': return J({ items: [{ id: hex(200), name: 'Staffel 1', type: 'Season', indexNumber: 1, genres: [], image: true, backdrop: false, logo: false, played: false, favorite: false, positionTicks: 0 }] });
        case 'episodes': return J({ items: episodes });
        case 'tracks': return J({ audio: [{ language: 'deu', title: 'Deutsch', isDefault: true }, { language: 'eng', title: 'English', isDefault: false }], subtitles: [{ language: 'deu', title: 'Deutsch' }], type: 'Movie' });
        case 'lists': return J({ lists: [] });
      }
    }
    if ((mm = p.match(/^\/api\/items\/([^/]+)$/))) {
      const it = find(mm[1]!) ?? byName('Inkwell');
      return J({ item: withFav(it), inWatchlist: st.watch.has(it.id), thumb: 0, langs: { audio: ['deu', 'eng'], subs: ['deu'] } });
    }

    if (/^\/api\/comments\/[^/]+$/.test(p) && m === 'DELETE') return J({ ok: true });

    // profiles (gate "Wer ist heute dabei?" and the avatar menu)
    if (p === '/api/profiles') return J({ profiles: PROFILES, max: 5, activeId: 'p1' });
    if ((mm = p.match(/^\/api\/profiles\/([^/]+)\/select$/)) && m === 'POST') return J({ ok: true });

    if (p.startsWith('/api/admin/')) { const r = adminRoute(st.admin, m, p, sp, body(), J); if (r) return r; }

    st.unmocked.add(`${m} ${p}${u.search ? '?…' : ''}`);
    return J({ items: [] });
  });
}

export { SERIES };
