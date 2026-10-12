import type { BrowserContext, Route } from '@playwright/test';
import { ME, byName, episodes, hex, items, nolan, people, seedLists, type MockItem, type MockList, MOVIE, MOVIE2, SERIES } from './fixtures.js';
import { pngFor } from './png.js';

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

    if (p === '/api/client-errors') { st.clientErrors.push(body()); return route.fulfill({ status: 204 }); }
    if (p === '/api/me') return J(ME);
    if (p === '/api/notifications') return J({ notifications: [{ id: 'n1', title: 'Anna hat dich zur Liste „Annas Klassiker“ eingeladen', link: '/lists/' + st.lists[1]!.id, read: false }] });
    if (p === '/api/notifications/read') return J({ ok: true });
    if (p === '/api/prefs') return J({ prefs: {} });
    if (p === '/api/push/config') return J({ enabled: false }); // settings page: push not set up on the mock server
    // UI language (block 14): profile language + admin instance default
    if (p === '/api/prefs/language' && m === 'PUT') return J({ language: body().language });
    if (p === '/api/admin/settings/language') return J(m === 'PUT' ? { language: body().language, set: true } : { language: 'de', set: true, languages: ['de', 'en', 'fr', 'es', 'it', 'tr', 'pl'] });
    if (p === '/api/watchlist/ids') return J({ ids: [...st.watch] });
    if (p === '/api/watchlist') return J({ items: [...st.watch].map(find).filter(Boolean).map((i) => withFav(i!)) });
    if (p === '/api/dropped') return J({ items: [...st.dropped].map(find).filter(Boolean) });
    if (p === '/api/library/resume') return J({ items: [episodes[0], items[2]] });
    if (p === '/api/library/nextup') return J({ items: [episodes[1]] });
    if (p === '/api/library/because') return J({ because: { name: 'Inception' }, items: items.slice(1, 12) });
    if (p === '/api/recommendations') return J({ items: items.slice(5, 10) });
    if (p === '/api/library/friends-rated') return J({ items: items.slice(2, 8) });
    if (p === '/api/library/trending') {
      const ago = new Date(Date.now() - 3 * 864e5).toISOString();
      return J({ items: [{ ...items[0], viewers: 4 }, { ...items[8], lastAdded: ago, unplayedCount: 4, childCount: 2, playedPercentage: 30, viewers: 3 }, { ...items[1], viewers: 3 }, { ...items[2], viewers: 2 }, { ...items[5], viewers: 2 }] });
    }
    if (p === '/api/library/views') return J({ items: [{ id: hex(900), name: 'Filme' }, { id: hex(901), name: 'Serien' }] });
    if (p === '/api/library/genres') return J({ genres: ['Action', 'Drama', 'Krimi', 'Sci-Fi', 'Thriller'] });
    if (p === '/api/library/languages') return J({ audio: [{ code: 'deu', count: 10 }, { code: 'eng', count: 8 }, { code: 'jpn', count: 3 }], subs: [{ code: 'deu', count: 9 }, { code: 'eng', count: 7 }] });
    if (p === '/api/library/collections') return J({ items: [], studios: ['Warner', 'A24'] });
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
      if (q.includes('nolan')) return J({ q, titles: nolan, episodes: [], people: [{ id: hex(300), name: 'Christopher Nolan', image: true }, { id: hex(305), name: 'Jonathan Nolan', image: false }], genres: [], partial: false });
      const titles = items.filter((i) => i.name.toLowerCase().includes(q));
      return J({ q, titles, episodes: q.includes('break') ? episodes.slice(0, 3) : [], people: [], genres: q.startsWith('dra') ? ['Drama'] : [], partial: false });
    }
    if ((mm = p.match(/^\/api\/people\/(.+)$/))) return J({ person: { id: mm[1], name: 'Christopher Nolan', overview: 'Britisch-amerikanischer Regisseur.', birthYear: 1970, image: true }, items: nolan });
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
    if (p.startsWith('/api/series/')) return J({ followed: false });

    // ----- lists -----
    if (p === '/api/lists/featured') return J({ lists: [] });
    if (p === '/api/lists' && m === 'GET') {
      return J({ lists: st.lists.map((l) => ({ id: l.id, name: l.name, description: l.description, owner: l.owner, role: l.role, itemCount: l.items.length, memberCount: l.members.length + 1, updatedAt: new Date().toISOString(), coverIds: l.items.slice(0, 4) })) });
    }
    if ((mm = p.match(/^\/api\/lists\/([^/]+)$/)) && m === 'GET') {
      const l = st.lists.find((x) => x.id === mm![1]);
      if (!l) return J({ error: 'not_found' }, 404);
      return J({ list: { id: l.id, name: l.name, description: l.description, owner: l.owner, role: l.role }, members: [{ id: l.owner.id, name: l.owner.name, role: 'owner' }, ...l.members], items: l.items.map(find).map((i) => ({ ...i, addedBy: { id: 'u2', name: 'Anna' }, addedAt: new Date().toISOString(), note: null })), hiddenCount: 0 });
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
        case 'seasons': return J({ items: [{ id: hex(200), name: 'Staffel 1', type: 'Season', indexNumber: 1, genres: [], image: true, backdrop: false, logo: false, played: false, favorite: false, positionTicks: 0 }] });
        case 'episodes': return J({ items: episodes });
        case 'tracks': return J({ audio: [{ language: 'deu', title: 'Deutsch', isDefault: true }, { language: 'eng', title: 'English', isDefault: false }], subtitles: [{ language: 'deu', title: 'Deutsch' }], type: 'Movie' });
        case 'lists': return J({ lists: [] });
      }
    }
    if ((mm = p.match(/^\/api\/items\/([^/]+)$/))) {
      const it = find(mm[1]!) ?? byName('Inception');
      return J({ item: withFav(it), inWatchlist: st.watch.has(it.id), thumb: 0, langs: { audio: ['deu', 'eng'], subs: ['deu'] } });
    }

    // profiles (gate "Wer schaut gerade?" and the avatar menu)
    if (p === '/api/profiles') return J({ profiles: PROFILES, max: 5, activeId: 'p1' });
    if ((mm = p.match(/^\/api\/profiles\/([^/]+)\/select$/)) && m === 'POST') return J({ ok: true });

    st.unmocked.add(`${m} ${p}${u.search ? '?…' : ''}`);
    return J({ items: [] });
  });
}

export { SERIES };
