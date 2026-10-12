import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { episodeFacts, instanceToday, movieLabel, qualityIndexTick, seriesLabel, leavingTick, SERIES_LABELS_PER_REQUEST, type EpisodeFacts } from '../src/fresh.js';
import { bestTraits, toMediaTraits } from '../src/jellyfin/dto.js';
import { ADMIN, makeEnv, type Handler, type TestEnv } from './helpers.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-12T12:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const agoReal = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const hex = (c: string) => c.repeat(32);

// ---------------------------------------------------------------- pure label rules

const ep = (season: number, index: number, addedDays: number | null, premiereDays: number | null = null): EpisodeFacts => ({
  season, index, addedAt: addedDays === null ? null : NOW - addedDays * DAY, premiere: premiereDays === null ? null : NOW - premiereDays * DAY,
});
const season = (n: number, count: number, startDays: number, lastDays: number): EpisodeFacts[] =>
  Array.from({ length: count }, (_, i) => ep(n, i + 1, i === count - 1 ? lastDays : startDays));
const oldSeries = { dateCreated: ago(400), premiereDate: ago(500) };

describe('fresh label rules', () => {
  it('movies: new in the library or premiered within 14 days', () => {
    expect(movieLabel({ dateCreated: ago(3) }, NOW)).toBe('new');
    expect(movieLabel({ dateCreated: ago(90), premiereDate: ago(5) }, NOW)).toBe('new');
    expect(movieLabel({ dateCreated: ago(90), premiereDate: ago(300) }, NOW)).toBeNull();
    expect(movieLabel({ dateCreated: ago(-30) }, NOW)).toBeNull(); // far in the future = bogus date
    expect(movieLabel({}, NOW)).toBeNull();
  });

  it('series: one label, priority new series > finale > new season > new episode', () => {
    // brand-new series (all episodes arrived at once) is "Neue Serie", never "Neue Folge"
    expect(seriesLabel({ dateCreated: ago(2) }, season(1, 8, 2, 2), { ended: false, unaired: 0 }, NOW)).toBe('newSeries');
    // season 1 of an old series arrived earlier, a new episode this week
    expect(seriesLabel(oldSeries, season(1, 10, 60, 1), { ended: false, unaired: 3 }, NOW)).toBe('newEpisode');
    // season 2 arrived in one go
    expect(seriesLabel(oldSeries, [...season(1, 8, 300, 300), ...season(2, 8, 3, 3)], { ended: true, unaired: 0 }, NOW)).toBe('newSeason');
    // first episode of a new season only
    expect(seriesLabel(oldSeries, [...season(1, 8, 300, 300), ep(2, 1, 2)], { ended: false, unaired: 0 }, NOW)).toBe('newSeason');
    // the last episode of an ended, complete season arrived this week while the season began long ago
    expect(seriesLabel(oldSeries, [...season(1, 8, 300, 300), ...season(2, 8, 50, 1)], { ended: true, unaired: 0 }, NOW)).toBe('finale');
  });

  it('a finale needs an ended series, no announced episodes left and a real season', () => {
    const eps = [...season(1, 8, 300, 300), ...season(2, 8, 50, 1)];
    expect(seriesLabel(oldSeries, eps, { ended: false, unaired: 0 }, NOW)).toBe('newEpisode'); // still continuing: not called a finale
    expect(seriesLabel(oldSeries, eps, { ended: true, unaired: 2 }, NOW)).toBe('newEpisode'); // more episodes announced
    expect(seriesLabel(oldSeries, [ep(1, 1, 40), ep(1, 2, 1)], { ended: true, unaired: 0 }, NOW)).toBe('newEpisode'); // two episodes: no finale
  });

  it('nothing recent = no label; an old import without dates stays quiet', () => {
    expect(seriesLabel(oldSeries, season(1, 10, 100, 40), { ended: true, unaired: 0 }, NOW)).toBeNull();
    expect(seriesLabel(oldSeries, [], { ended: true, unaired: 0 }, NOW)).toBeNull();
    expect(seriesLabel({ dateCreated: ago(300), premiereDate: ago(5) }, [], { ended: false, unaired: 0 }, NOW)).toBe('newSeries');
  });

  it('episodeFacts keeps only numbered episodes and defaults the season', () => {
    const f = episodeFacts([
      { id: 'a', name: 'x', type: 'Episode', genres: [], image: false, backdrop: false, logo: false, trailers: 0, played: false, favorite: false, positionTicks: 0, indexNumber: 2, parentIndexNumber: 3, dateCreated: ago(1) },
      { id: 'b', name: 'y', type: 'Episode', genres: [], image: false, backdrop: false, logo: false, trailers: 0, played: false, favorite: false, positionTicks: 0 },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ season: 3, index: 2 });
  });
});

describe('leaving-soon days count in the instance time zone', () => {
  it('uses TZ (Europe/Vienna is already tomorrow at 23:30 UTC), UTC when unset or unknown', () => {
    const late = new Date('2026-10-12T23:30:00Z');
    expect(instanceToday(late, 'Europe/Vienna')).toBe('2026-10-13');
    expect(instanceToday(late, 'UTC')).toBe('2026-10-12');
    expect(instanceToday(late, '')).toBe('2026-10-12');
    expect(instanceToday(late, 'Mars/Olympus')).toBe('2026-10-12');
  });
});

describe('media traits mapping', () => {
  const video = (o: Record<string, unknown>) => ({ Type: 'Video', Width: 1920, Height: 1080, VideoRangeType: 'SDR', ...o });
  it('resolution classes (cropped scope films count by width)', () => {
    expect(toMediaTraits([video({ Width: 3840, Height: 2160 })])!.resolution).toBe('4k');
    expect(toMediaTraits([video({ Width: 3840, Height: 1600 })])!.resolution).toBe('4k');
    expect(toMediaTraits([video({})])!.resolution).toBe('hd');
    expect(toMediaTraits([video({ Width: 1280, Height: 720 })])!.resolution).toBe('hd');
    expect(toMediaTraits([video({ Width: 720, Height: 576 })])!.resolution).toBe('sd');
    expect(toMediaTraits([{ Type: 'Audio' }])).toBeNull();
    expect(toMediaTraits(undefined)).toBeNull();
  });
  it('HDR flavours', () => {
    const hdr = (t: string) => toMediaTraits([video({ VideoRangeType: t })])!.hdr;
    expect(hdr('SDR')).toBeNull();
    expect(hdr('HDR10')).toBe('hdr10');
    expect(hdr('HDR10Plus')).toBe('hdr10plus');
    expect(hdr('DOVIWithHDR10')).toBe('dolbyvision');
    expect(hdr('HLG')).toBe('hlg');
    expect(hdr('DOVIWithSDR')).toBe('dolbyvision');
    expect(hdr('DOVIInvalid')).toBeNull();
    expect(toMediaTraits([video({ VideoRangeType: undefined, VideoRange: 'HDR' })])!.hdr).toBe('hdr10'); // older servers
  });
  it('audio: Atmos beats channel count, then surround / stereo / mono', () => {
    const a = (...s: Array<Record<string, unknown>>) => toMediaTraits([video({}), ...s.map((x) => ({ Type: 'Audio', ...x }))])!.audio;
    expect(a({ Channels: 8, Profile: 'Dolby TrueHD + Dolby Atmos' })).toBe('atmos');
    expect(a({ Channels: 6, AudioSpatialFormat: 'DolbyAtmos' })).toBe('atmos');
    expect(a({ Channels: 2 }, { Channels: 6 })).toBe('surround');
    expect(a({ Channels: 2 })).toBe('stereo');
    expect(a({ Channels: 1 })).toBe('mono');
    expect(a()).toBeNull();
  });
  it('bestTraits merges episodes', () => {
    expect(bestTraits({ resolution: 'hd', hdr: null, audio: 'stereo' }, { resolution: '4k', hdr: 'hdr10', audio: 'surround' })).toEqual({ resolution: '4k', hdr: 'hdr10', audio: 'surround' });
    expect(bestTraits(null, { resolution: 'sd', hdr: null, audio: null })).toEqual({ resolution: 'sd', hdr: null, audio: null });
  });
});

// ---------------------------------------------------------------- routes (fake media server with per-user visibility)

const NEW_MOVIE = hex('1'), OLD_MOVIE = hex('2'), SECRET = hex('3'), SERIES = hex('4'), UHD = hex('5'), HDR_ONLY = hex('6'), KIDSAFE = hex('7');
const EP = (n: number) => `${n}`.padStart(32, 'e');
let env: TestEnv;
let adm: { cookies: Record<string, string>; csrf: string };
let fri: { cookies: Record<string, string>; csrf: string };
/** usernames (Jellyfin side) that must not see an item */
const blocked = new Map<string, Set<string>>();
/** continuing series as the ADMIN key lists them (library-wide); empty = the test series has ended */
let continuingAdmin: string[] = [];
const tokenUser = (init: RequestInit) => /Token="tok-([^"]+)"/.exec(String((init.headers as Record<string, string>)?.Authorization ?? ''))?.[1];
const LIB: Record<string, any> = {
  [NEW_MOVIE]: { Id: NEW_MOVIE, Name: 'Frisch', Type: 'Movie', DateCreated: agoReal(2), ProductionYear: 2026 },
  [OLD_MOVIE]: { Id: OLD_MOVIE, Name: 'Altfilm', Type: 'Movie', DateCreated: agoReal(400), ProductionYear: 1999 },
  [SECRET]: { Id: SECRET, Name: 'Geheimtitel', Type: 'Movie', DateCreated: agoReal(1) },
  [SERIES]: { Id: SERIES, Name: 'Die Serie', Type: 'Series', DateCreated: agoReal(500), DateLastMediaAdded: agoReal(1) },
  [UHD]: { Id: UHD, Name: 'Ultra', Type: 'Movie', DateCreated: agoReal(100) },
  [HDR_ONLY]: { Id: HDR_ONLY, Name: 'Nur HDR', Type: 'Movie', DateCreated: agoReal(100) },
  [KIDSAFE]: { Id: KIDSAFE, Name: 'Nur HD', Type: 'Movie', DateCreated: agoReal(100) },
};
const STREAMS: Record<string, any[]> = {
  [UHD]: [{ Type: 'Video', Width: 3840, Height: 2160, VideoRangeType: 'DOVIWithHDR10' }, { Type: 'Audio', Channels: 8, Profile: 'Dolby Atmos' }],
  [HDR_ONLY]: [{ Type: 'Video', Width: 1920, Height: 1080, VideoRangeType: 'HDR10' }, { Type: 'Audio', Channels: 6 }],
  [KIDSAFE]: [{ Type: 'Video', Width: 1920, Height: 1080, VideoRangeType: 'SDR' }, { Type: 'Audio', Channels: 2 }],
  [NEW_MOVIE]: [{ Type: 'Video', Width: 3840, Height: 2160, VideoRangeType: 'SDR' }],
};
// season 1 long ago (8 episodes), season 2 began 50 days ago and its last episode arrived yesterday: a finale of an ended series
const EPISODES = [
  ...Array.from({ length: 8 }, (_, i) => ({ Id: EP(i + 1), Name: `S1E${i + 1}`, Type: 'Episode', SeriesId: SERIES, ParentIndexNumber: 1, IndexNumber: i + 1, DateCreated: agoReal(300), UserData: { Played: true, LastPlayedDate: agoReal(70) }, Overview: `Folge ${i + 1} Handlung` })),
  ...Array.from({ length: 6 }, (_, i) => ({ Id: EP(i + 20), Name: `S2E${i + 1}`, Type: 'Episode', SeriesId: SERIES, ParentIndexNumber: 2, IndexNumber: i + 1, DateCreated: agoReal(i === 5 ? 1 : 50), UserData: {} })),
];

const visible = (init: RequestInit, id: string) => !blocked.get(tokenUser(init) ?? '')?.has(id);
const jelly: Record<string, Handler> = {
  'GET /Items': (u, init) => {
    const ids = u.searchParams.get('ids')?.split(',');
    if (u.searchParams.get('seriesStatus')) { // nothing continuing for viewers; the admin-level listing is paged (see continuingAdmin)
      if (tokenUser(init)) return { json: { Items: [] } };
      const st = Number(u.searchParams.get('startIndex') ?? 0), lim = Number(u.searchParams.get('limit') ?? 100);
      return { json: { Items: continuingAdmin.slice(st, st + lim).map((Id) => ({ Id, Type: 'Series' })) } };
    }
    if (u.searchParams.get('includeItemTypes') === 'Episode' && u.searchParams.get('isMissing') === 'false') {
      return { json: { Items: (ids ?? []).filter((i) => EPISODES.some((e) => e.Id === i)).map((Id) => ({ Id, LocationType: 'FileSystem' })) } };
    }
    if (!tokenUser(init) && u.searchParams.get('fields')?.includes('MediaStreams')) { // admin key: quality index scan
      const type = u.searchParams.get('includeItemTypes');
      const items = type === 'Movie' ? Object.values(LIB).filter((i) => i.Type === 'Movie').map((i) => ({ Id: i.Id, MediaStreams: STREAMS[i.Id] ?? [] })) : [];
      return { json: { Items: items.slice(Number(u.searchParams.get('startIndex') ?? 0), Number(u.searchParams.get('startIndex') ?? 0) + Number(u.searchParams.get('limit') ?? 200)) } };
    }
    if (ids && u.searchParams.get('fields')?.includes('MediaStreams')) {
      return { json: { Items: ids.filter((i) => LIB[i] && visible(init, i)).map((i) => ({ ...LIB[i], MediaStreams: STREAMS[i] ?? [] })) } };
    }
    const list = (ids ? ids.map((i) => LIB[i]).filter(Boolean) : Object.values(LIB)).filter((i) => visible(init, i.Id));
    return { json: { Items: list, TotalRecordCount: list.length } };
  },
  'GET /Items/[^/]+': (u, init) => {
    const id = u.pathname.split('/')[2]!;
    return LIB[id] && visible(init, id) ? { json: LIB[id] } : { status: 404 };
  },
  'GET /Shows/[^/]+/Episodes': (u) => ({ json: { Items: u.pathname.split('/')[2] === SERIES ? EPISODES : [] } }),
  'GET /Shows/[^/]+/Seasons': () => ({ json: { Items: [{ Id: hex('9'), Name: 'Staffel 1', Type: 'Season', IndexNumber: 1, Overview: 'Die erste Staffel erzählt vom Aufbruch.' }, { Id: hex('8'), Name: 'Staffel 2', Type: 'Season', IndexNumber: 2, Overview: 'SPOILER der zweiten Staffel' }] } }),
  'GET /Items/Resume': () => ({ json: { Items: [] } }),
};

beforeAll(async () => {
  env = await makeEnv(jelly);
  adm = await env.login(ADMIN);
  const inv = await env.app.inject({ method: 'POST', url: '/api/admin/invites', cookies: adm.cookies, headers: { 'x-csrf-token': adm.csrf }, payload: { role: 'friend', ttlHours: 1 } });
  env.claims.current = { sub: 'sub-fri', email: 'fri@example.com', name: 'Fia', groups: [] };
  const l = await env.app.inject(`/auth/login?invite=${inv.json().link.split('/').pop()}`);
  const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
  const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
  fri = { cookies: { ff_sid: sid }, csrf: (await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid } })).json().csrfToken };
});
afterAll(() => env.close());

const post = (s: typeof adm, url: string, payload: unknown) => env.app.inject({ method: 'POST', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: payload as object });
const put = (s: typeof adm, url: string, payload: unknown) => env.app.inject({ method: 'PUT', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: payload as object });
const del = (s: typeof adm, url: string) => env.app.inject({ method: 'DELETE', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf } });
const get = (s: typeof adm, url: string) => env.app.inject({ url, cookies: s.cookies });
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

describe('leaving soon: admin routes', () => {
  it('needs an admin (and a login)', async () => {
    expect((await env.app.inject({ method: 'PUT', url: `/api/admin/leaving/${OLD_MOVIE}`, payload: { leavesAt: day(5) } })).statusCode).toBe(401);
    expect((await put(fri, `/api/admin/leaving/${OLD_MOVIE}`, { leavesAt: day(5) })).statusCode).toBe(403);
    expect((await get(fri, '/api/admin/leaving')).statusCode).toBe(403);
    expect((await del(fri, `/api/admin/leaving/${OLD_MOVIE}`)).statusCode).toBe(403);
  });

  it('validates date, range and item type', async () => {
    expect((await put(adm, `/api/admin/leaving/${OLD_MOVIE}`, { leavesAt: '2026-02-30' })).statusCode).toBe(400);
    expect((await put(adm, `/api/admin/leaving/${OLD_MOVIE}`, { leavesAt: 'morgen' })).statusCode).toBe(400);
    expect((await put(adm, `/api/admin/leaving/${OLD_MOVIE}`, { leavesAt: day(-2) })).statusCode).toBe(400);
    expect((await put(adm, `/api/admin/leaving/${OLD_MOVIE}`, { leavesAt: day(900) })).statusCode).toBe(400);
    expect((await put(adm, '/api/admin/leaving/nothex', { leavesAt: day(3) })).statusCode).toBe(400);
    expect((await put(adm, `/api/admin/leaving/${hex('d')}`, { leavesAt: day(3) })).statusCode).toBe(404); // unknown title
    expect((await put(adm, `/api/admin/leaving/${EP(1)}`, { leavesAt: day(3) })).statusCode).toBe(404); // not in the fake library
  });

  it('sets, lists, updates and clears a date (audited)', async () => {
    const r = await put(adm, `/api/admin/leaving/${OLD_MOVIE}`, { leavesAt: day(5), note: ' Lizenz endet ' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ itemId: OLD_MOVIE, leavesAt: day(5), note: 'Lizenz endet' });
    await put(adm, `/api/admin/leaving/${SECRET}`, { leavesAt: day(40) });
    const l = (await get(adm, '/api/admin/leaving')).json().items as Array<Record<string, unknown>>;
    expect(l.map((x) => x.itemId)).toEqual([OLD_MOVIE, SECRET]);
    expect(l[0]).toMatchObject({ name: 'Altfilm', type: 'Movie', days: 5, note: 'Lizenz endet', setBy: 'Admin' });
    await put(adm, `/api/admin/leaving/${OLD_MOVIE}`, { leavesAt: day(6), note: null });
    expect(((await get(adm, '/api/admin/leaving')).json().items as Array<Record<string, unknown>>)[0]).toMatchObject({ days: 6, note: null });
    const audits = (await env.pool.query("select action, target from audit_log where action like 'leaving.%' order by id")).rows;
    expect(audits.map((a) => a.action)).toEqual(['leaving.set', 'leaving.set', 'leaving.set']);
    await del(adm, `/api/admin/leaving/${SECRET}`);
    expect(((await get(adm, '/api/admin/leaving')).json().items as unknown[]).length).toBe(1);
    expect((await env.pool.query("select 1 from audit_log where action = 'leaving.clear' and target = $1", [SECRET])).rowCount).toBe(1);
    expect((await del(adm, `/api/admin/leaving/${SECRET}`)).statusCode).toBe(200); // idempotent
  });
});

describe('badges and facts', () => {
  it('requires a login and a sane body', async () => {
    expect((await env.app.inject({ method: 'POST', url: '/api/discover/badges', payload: { ids: [NEW_MOVIE] } })).statusCode).toBe(401);
    expect((await post(fri, '/api/discover/badges', { ids: [] })).statusCode).toBe(400);
    expect((await post(fri, '/api/discover/badges', { ids: ['x'] })).statusCode).toBe(400);
    expect((await post(fri, '/api/discover/badges', { ids: Array.from({ length: 81 }, (_, i) => hex((i % 10).toString())) })).statusCode).toBe(400);
  });

  it('labels movies and series, adds the leaving days and never answers for titles the viewer cannot see', async () => {
    blocked.set('fia', new Set());
    const r = await post(fri, '/api/discover/badges', { ids: [NEW_MOVIE, OLD_MOVIE, SERIES, SECRET] });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json().badges as Record<string, { fresh?: string; daysLeft?: number }>;
    expect(b[NEW_MOVIE]).toEqual({ fresh: 'new' });
    expect(b[OLD_MOVIE]).toEqual({ daysLeft: 6 });
    expect(b[SERIES]).toEqual({ fresh: 'finale' });
    expect(b[SECRET]).toEqual({ fresh: 'new' });
    // the same request for a viewer who is not allowed to see two of the titles
    const names = (await env.pool.query<{ jellyfin_username: string }>('select jellyfin_username from users where name = $1', ['Fia'])).rows[0]!.jellyfin_username;
    blocked.set(names, new Set([NEW_MOVIE, OLD_MOVIE, SECRET]));
    env.ctx.jf.forgetItems();
    const hidden = (await post(fri, '/api/discover/badges', { ids: [NEW_MOVIE, OLD_MOVIE, SERIES, SECRET] })).json().badges as Record<string, unknown>;
    expect(Object.keys(hidden)).toEqual([SERIES]);
    expect(JSON.stringify(hidden)).not.toContain('daysLeft');
    blocked.clear();
    env.ctx.jf.forgetItems();
  });

  it('the continuing set is library-wide (admin key) and paged through completely: no false finale beyond the first page', async () => {
    // the viewer-level listing knows nothing (restricted viewer / limit) - the admin listing has the series on its second page
    continuingAdmin = [...Array.from({ length: 700 }, (_, i) => `${i}`.padStart(32, 'c')), SERIES];
    await env.kv.del(`fresh:s:${SERIES}`); await env.kv.del('fresh:continuing:lib');
    const before = env.jfCalls.length;
    const b = (await post(fri, '/api/discover/badges', { ids: [SERIES] })).json().badges as Record<string, { fresh?: string }>;
    expect(b[SERIES]).toEqual({ fresh: 'newEpisode' }); // continuing: never "Staffelfinale"
    const pages = env.jfCalls.slice(before).filter((c) => c.search.includes('seriesStatus=Continuing'));
    expect(pages.map((c) => new URLSearchParams(c.search).get('startIndex'))).toEqual(['0', '500']);
    expect(pages.every((c) => !c.auth?.includes('tok-') && new URLSearchParams(c.search).get('sortBy') === 'SortName,Id')).toBe(true);
    continuingAdmin = [];
    await env.kv.del(`fresh:s:${SERIES}`); await env.kv.del('fresh:continuing:lib');
    expect((await post(fri, '/api/discover/badges', { ids: [SERIES] })).json().badges[SERIES]).toEqual({ fresh: 'finale' });
  });

  it('series labels are cached (one episode lookup per 15 minutes)', async () => {
    const before = env.jfCalls.filter((c) => c.path === `/Shows/${SERIES}/Episodes`).length;
    await post(fri, '/api/discover/badges', { ids: [SERIES] });
    await post(adm, '/api/discover/badges', { ids: [SERIES] });
    expect(env.jfCalls.filter((c) => c.path === `/Shows/${SERIES}/Episodes`).length).toBe(before);
  });

  it('facts: leaving date + chips for one title, 404 for hidden titles, the note only for admins', async () => {
    await put(adm, `/api/admin/leaving/${UHD}`, { leavesAt: day(3), note: 'intern' });
    const f = await get(fri, `/api/items/${UHD}/facts`);
    expect(f.statusCode, f.body).toBe(200);
    expect(f.json()).toEqual({ fresh: null, leaving: { leavesAt: day(3), days: 3 }, traits: { resolution: '4k', hdr: 'dolbyvision', audio: 'atmos' }, admin: false });
    expect((await get(adm, `/api/items/${UHD}/facts`)).json().admin).toBe(true);
    expect((await get(adm, `/api/items/${UHD}/facts`)).json().leaving).toMatchObject({ note: 'intern' });
    expect(f.body).not.toContain('intern');
    const names = (await env.pool.query<{ jellyfin_username: string }>('select jellyfin_username from users where name = $1', ['Fia'])).rows[0]!.jellyfin_username;
    blocked.set(names, new Set([SECRET]));
    expect((await get(fri, `/api/items/${SECRET}/facts`)).statusCode).toBe(404);
    expect((await env.app.inject(`/api/items/${UHD}/facts`)).statusCode).toBe(401);
    blocked.clear();
    await del(adm, `/api/admin/leaving/${UHD}`);
  });
});

describe('home row Bald nicht mehr verfügbar', () => {
  it('lists only dates within 30 days and only titles the viewer can see, soonest first', async () => {
    await put(adm, `/api/admin/leaving/${NEW_MOVIE}`, { leavesAt: day(20) });
    await put(adm, `/api/admin/leaving/${SECRET}`, { leavesAt: day(2) });
    await put(adm, `/api/admin/leaving/${SERIES}`, { leavesAt: day(45) }); // too far away for the row
    const names = (await env.pool.query<{ jellyfin_username: string }>('select jellyfin_username from users where name = $1', ['Fia'])).rows[0]!.jellyfin_username;
    const all = (await get(fri, '/api/library/leaving')).json().items as Array<{ id: string; daysLeft: number }>;
    expect(all.map((i) => [i.id, i.daysLeft])).toEqual([[SECRET, 2], [OLD_MOVIE, 6], [NEW_MOVIE, 20]]);
    blocked.set(names, new Set([SECRET]));
    env.ctx.jf.forgetItems();
    const seen = await get(fri, '/api/library/leaving');
    expect(seen.json().items.map((i: { id: string }) => i.id)).toEqual([OLD_MOVIE, NEW_MOVIE]);
    expect(seen.body).not.toContain('Geheimtitel');
    expect((await env.app.inject('/api/library/leaving')).statusCode).toBe(401);
    blocked.clear();
    env.ctx.jf.forgetItems();
  });
});

describe('leaving soon: notifications and clean-up', () => {
  it('notifies the account once per stage, only for My List / Continue Watching and only when every profile can see the title', async () => {
    const uid = (await env.pool.query<{ id: string }>("select id from users where name = 'Fia'")).rows[0]!.id;
    const owner = (await env.pool.query<{ id: string }>('select id from profiles where user_id = $1 and is_owner', [uid])).rows[0]!.id;
    await env.pool.query('delete from leaving_soon');
    await put(adm, `/api/admin/leaving/${OLD_MOVIE}`, { leavesAt: day(5) });
    await put(adm, `/api/admin/leaving/${NEW_MOVIE}`, { leavesAt: day(4) });
    await put(adm, `/api/admin/leaving/${UHD}`, { leavesAt: day(20) }); // beyond a week: no notice yet
    await put(adm, `/api/admin/leaving/${SECRET}`, { leavesAt: day(1) });
    await env.pool.query('insert into watchlist(user_id, profile_id, item_id) values ($1,$2,$3),($1,$2,$4),($1,$2,$5)', [uid, owner, OLD_MOVIE, UHD, SECRET]);
    // NEW_MOVIE is on nobody's list -> no notice. SECRET is on the list but not visible to the account's profile.
    const names = (await env.pool.query<{ jellyfin_username: string }>('select jellyfin_username from users where name = $1', ['Fia'])).rows[0]!.jellyfin_username;
    blocked.set(names, new Set([SECRET]));
    env.ctx.jf.forgetItems();
    expect(await leavingTick(env.ctx)).toBe(1);
    const rows = (await env.pool.query('select kind, title, body, link, dedupe, msg from notifications where user_id = $1', [uid])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'leaving', link: `/item/${OLD_MOVIE}`, title: '„Altfilm“ ist nur noch 5 Tage verfügbar' });
    expect(rows[0].msg.title).toMatchObject({ key: 'leaving.days' });
    expect(JSON.stringify(rows)).not.toContain('Geheimtitel');
    expect(await leavingTick(env.ctx)).toBe(0); // dedupe: nothing twice
    // the last two days are a second notice
    await env.pool.query('update leaving_soon set leaves_at = current_date + 1 where item_id = $1', [OLD_MOVIE]);
    expect(await leavingTick(env.ctx)).toBe(1);
    const days = (await env.pool.query("select title from notifications where user_id = $1 and dedupe like 'leave-day-%'", [uid])).rows;
    expect(days[0].title).toBe('„Altfilm“ ist nur noch 1 Tag verfügbar');
    await env.pool.query('update leaving_soon set leaves_at = current_date where item_id = $1', [OLD_MOVIE]);
    await env.pool.query("delete from notifications where kind = 'leaving'");
    expect(await leavingTick(env.ctx)).toBe(1);
    expect((await env.pool.query("select title from notifications where kind = 'leaving'")).rows[0].title).toBe('„Altfilm“ ist nur noch heute verfügbar');
    blocked.clear();
  });

  it('kids profiles never trigger a notice and expired dates are removed', async () => {
    const uid = (await env.pool.query<{ id: string }>("select id from users where name = 'Fia'")).rows[0]!.id;
    const kid = (await post(fri, '/api/profiles', { name: 'Kind', kids: true, maxRating: 6 })).json().profile.id as string;
    await env.pool.query('delete from notifications where kind = $1', ['leaving']);
    await env.pool.query('delete from watchlist where user_id = $1', [uid]);
    await env.pool.query('delete from leaving_soon');
    await env.pool.query('insert into leaving_soon(item_id, leaves_at) values ($1, current_date + 2), ($2, current_date - 1)', [OLD_MOVIE, NEW_MOVIE]);
    await env.pool.query('insert into watchlist(user_id, profile_id, item_id) values ($1,$2,$3)', [uid, kid, OLD_MOVIE]);
    expect(await leavingTick(env.ctx)).toBe(0);
    expect((await env.pool.query("select 1 from notifications where kind = 'leaving'")).rowCount).toBe(0);
    expect((await env.pool.query('select item_id from leaving_soon')).rows.map((r) => r.item_id)).toEqual([OLD_MOVIE]); // the expired date was cleaned
  });
});

describe('browse filter 4K / HDR', () => {
  it('index + route: 4K, HDR and both, visibility from the media server, filters combine', async () => {
    const before = env.jfCalls.length;
    await qualityIndexTick(env.ctx, { force: true });
    // the paged admin scan has a stable order (else pages taken while the library changes skip / repeat titles)
    const scans = env.jfCalls.slice(before).filter((c) => c.search.includes('MediaStreams'));
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.every((c) => new URLSearchParams(c.search).get('sortBy') === 'SortName,Id')).toBe(true);
    expect((await env.pool.query('select item_id, res, hdr, audio from item_quality order by item_id')).rows.map((r) => `${r.item_id.slice(0, 1)}:${r.res}:${r.hdr}:${r.audio}`)).toEqual([
      '1:4k:null:null', '2:sd:null:null', '3:sd:null:null', '5:4k:dolbyvision:atmos', '6:hd:hdr10:surround', '7:hd:null:stereo',
    ]);
    const ids = async (q: string, s = fri) => ((await get(s, `/api/library/quality?${q}`)).json().items as Array<{ id: string }>).map((i) => i.id);
    expect((await ids('quality=4k')).sort()).toEqual([NEW_MOVIE, UHD]);
    expect(await ids('quality=hdr')).toEqual(expect.arrayContaining([UHD, HDR_ONLY]));
    expect((await ids('quality=hdr')).length).toBe(2);
    expect(await ids('quality=4k,hdr')).toEqual([UHD]);
    expect(await ids('quality=4k&sort=SortName&desc=true')).toEqual([UHD, NEW_MOVIE]); // 'Ultra' after 'Frisch' descending
    const total = (await get(fri, '/api/library/quality?quality=4k&limit=1')).json();
    expect(total).toMatchObject({ total: 2 });
    expect(total.items).toHaveLength(1);
    // titles the viewer cannot see never appear
    const names = (await env.pool.query<{ jellyfin_username: string }>('select jellyfin_username from users where name = $1', ['Fia'])).rows[0]!.jellyfin_username;
    blocked.set(names, new Set([UHD]));
    expect(await ids('quality=4k')).toEqual([NEW_MOVIE]);
    blocked.clear();
  });

  it('rejects bad parameters and anonymous callers', async () => {
    expect((await env.app.inject('/api/library/quality?quality=4k')).statusCode).toBe(401);
    expect((await get(fri, '/api/library/quality?quality=8k')).statusCode).toBe(400);
    expect((await get(fri, '/api/library/quality')).statusCode).toBe(400);
    expect((await get(fri, '/api/library/quality?quality=4k&types=Episode')).statusCode).toBe(400);
  });
});

describe('browse filter 4K / HDR: kids profile, cached list, parallel chunks', () => {
  it('a kids profile gets only what ITS media-server identity may see, even right after the owner warmed the cache', async () => {
    await qualityIndexTick(env.ctx, { force: true });
    const kid = (await post(fri, '/api/profiles', { name: 'Kino-Kind', kids: true, maxRating: 6 })).json().profile.id as string;
    const kidJf = (await env.pool.query<{ u: string }>('select jellyfin_username u from profiles where id = $1', [kid])).rows[0]!.u;
    blocked.set(kidJf, new Set([UHD]));
    const ids = async (s: typeof fri, q: string) => ((await get(s, `/api/library/quality?${q}`)).json().items as Array<{ id: string }>).map((i) => i.id).sort();
    expect(await ids(fri, 'quality=4k&sort=DateCreated')).toEqual([NEW_MOVIE, UHD].sort());
    const sel = await post(fri, `/api/profiles/${kid}/select`, {});
    expect(sel.statusCode, sel.body).toBe(200);
    const kidSess = { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: fri.csrf };
    const r = await get(kidSess, '/api/library/quality?quality=4k&sort=DateCreated');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().items.map((i: { id: string }) => i.id)).toEqual([NEW_MOVIE]);
    expect(r.json().total).toBe(1);
    expect(r.body).not.toContain('Ultra');
    blocked.clear();
  });

  it('paging re-uses the viewer\'s cached id list (one lookup per page, no re-scan of every chunk)', async () => {
    await get(fri, '/api/library/quality?quality=hdr&sort=CommunityRating&limit=1');
    const before = env.jfCalls.length;
    const p2 = (await get(fri, '/api/library/quality?quality=hdr&sort=CommunityRating&limit=1&start=1')).json();
    expect(p2).toMatchObject({ total: 2 });
    expect(p2.items).toHaveLength(1);
    const calls = env.jfCalls.slice(before).filter((c) => c.path === '/Items');
    expect(calls).toHaveLength(1);
    expect(new URLSearchParams(calls[0]!.search).get('ids')!.split(',')).toHaveLength(1);
  });

  it('chunks run in parallel (capped at 4 in flight)', async () => {
    // 300 4K candidates = 4 chunks of 80; a slow media server must see them overlap
    const extra = Array.from({ length: 300 }, (_, i) => `${i}`.padStart(32, 'a'));
    await env.pool.query("insert into item_quality(item_id, type, res, indexed_at) select x, 'Movie', '4k', now() from unnest($1::text[]) x on conflict do nothing", [extra]);
    let inFlight = 0, peak = 0;
    const orig = env.ctx.jf.items.bind(env.ctx.jf);
    env.ctx.jf.items = (async (u: Parameters<typeof orig>[0], q: Parameters<typeof orig>[1]) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      try { return await orig(u, q); } finally { inFlight--; }
    }) as typeof orig;
    try {
      expect((await get(adm, '/api/library/quality?quality=4k&sort=PremiereDate')).statusCode).toBe(200);
    } finally {
      env.ctx.jf.items = orig;
      await env.pool.query('delete from item_quality where item_id = any($1)', [extra]);
    }
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe('Story so far', () => {
  it('shows the last completed season and the last watched episode when a new season starts (even after a long break), never the running season', async () => {
    const r = await get(fri, `/api/items/${SERIES}/story`);
    expect(r.statusCode, r.body).toBe(200);
    const s = r.json().story;
    expect(s).toMatchObject({ reason: 'newSeason', weeks: 10, season: { number: 1, overview: 'Die erste Staffel erzählt vom Aufbruch.' }, episode: { id: EP(8), overview: 'Folge 8 Handlung', season: 1, index: 8 }, next: { id: EP(20), season: 2, index: 1 } });
    expect(r.body).not.toContain('SPOILER');
  });
  it('answers null for movies, unwatched series and recent viewers; 404/401 as usual', async () => {
    expect((await get(fri, `/api/items/${OLD_MOVIE}/story`)).json()).toEqual({ story: null });
    expect((await env.app.inject(`/api/items/${SERIES}/story`)).statusCode).toBe(401);
    expect((await get(fri, `/api/items/${hex('d')}/story`)).statusCode).toBe(404);
    // watched yesterday and still inside season 1: nothing to remind of
    const saved = EPISODES.slice(0, 8).map((e) => e.UserData);
    EPISODES.slice(0, 8).forEach((e, i) => { e.UserData = i < 4 ? { Played: true, LastPlayedDate: agoReal(1) } : {}; });
    expect((await get(fri, `/api/items/${SERIES}/story`)).json()).toEqual({ story: null });
    // eight weeks without watching, still inside season 1: only the last episode (a running season's overview could spoil)
    EPISODES.slice(0, 8).forEach((e, i) => { e.UserData = i < 4 ? { Played: true, LastPlayedDate: agoReal(56) } : {}; });
    const brk = (await get(fri, `/api/items/${SERIES}/story`)).json().story;
    expect(brk).toMatchObject({ reason: 'longBreak', weeks: 8, episode: { id: EP(4), overview: 'Folge 4 Handlung' }, next: { id: EP(5) } });
    expect(brk.season).toBeUndefined();
    // new season: season 1 finished yesterday, season 2 not started
    EPISODES.slice(0, 8).forEach((e) => { e.UserData = { Played: true, LastPlayedDate: agoReal(1) }; });
    expect((await get(fri, `/api/items/${SERIES}/story`)).json().story).toMatchObject({ reason: 'newSeason', season: { number: 1 } });
    EPISODES.slice(0, 8).forEach((e, i) => { e.UserData = saved[i]!; });
  });
});

describe('rate limits and per-request work of the Block 17 batch routes', () => {
  it('badges label at most SERIES_LABELS_PER_REQUEST uncached series per request', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `${i}`.padStart(32, 'b'));
    for (const id of many) LIB[id] = { Id: id, Name: `Serie ${id.slice(-2)}`, Type: 'Series', DateCreated: agoReal(500), DateLastMediaAdded: agoReal(1) };
    const before = env.jfCalls.length;
    expect((await post(fri, '/api/discover/badges', { ids: many })).statusCode).toBe(200);
    const lookups = env.jfCalls.slice(before).filter((c) => /^\/Shows\/[^/]+\/Episodes$/.test(c.path)).length;
    expect(lookups).toBe(SERIES_LABELS_PER_REQUEST);
    for (const id of many) delete LIB[id];
  });

  it('badges and the quality browse answer 429 after 60 requests a minute per session (other sessions unaffected)', async () => {
    const s = await env.login(ADMIN);
    for (const [method, url] of [['POST', '/api/discover/badges'], ['GET', '/api/library/quality?quality=4k']] as const) {
      const codes: number[] = [];
      for (let i = 0; i < 61; i++) {
        codes.push((await env.app.inject({ method, url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, ...(method === 'POST' ? { payload: { ids: [OLD_MOVIE] } } : {}) })).statusCode);
      }
      expect(codes.slice(0, 60).every((c) => c === 200)).toBe(true);
      expect(codes[60]).toBe(429);
    }
    expect((await post(fri, '/api/discover/badges', { ids: [OLD_MOVIE] })).statusCode).toBe(200);
  });
});
