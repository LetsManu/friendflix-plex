import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanComment, isAnime, seasonOf } from '../src/routes/anime.js';
import { makeEnv, type TestEnv } from './helpers.js';

const hex = (n: number) => n.toString(16).padStart(32, '0');
const SERIES = hex(1), EP1 = hex(2), EP2 = hex(3), MOVIE = hex(4), HIDDEN = hex(5), SER2 = hex(6), SER3 = hex(7);
let env: TestEnv;
type Sess = { cookies: Record<string, string>; csrf: string };
let admin: Sess, friend: Sess;
/** Jellyfin user ids that have watched EP1 */
const watchedBy = new Set<string>();
const NOW = Date.now();
const iso = (days: number) => new Date(NOW + days * 86_400_000).toISOString();

const req = (s: Sess, method: string, url: string, payload?: object) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload });

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items/[^/]+': (u) => {
      const id = u.pathname.split('/')[2]!;
      if (id === HIDDEN) return { status: 404 };
      const uid = u.searchParams.get('userId') ?? '';
      const type = id === SERIES || id === SER2 || id === SER3 ? 'Series' : id === MOVIE ? 'Movie' : 'Episode';
      const played = id === EP1 && watchedBy.has(uid);
      return { json: { Id: id, Name: 'T', Type: type, SeriesId: type === 'Episode' ? SERIES : undefined, UserData: { Played: played } } };
    },
    'GET /Items': (u) => {
      if (u.searchParams.get('includeItemTypes') === 'Series') {
        return { json: { Items: [
          { Id: SERIES, Name: 'Aoi', Type: 'Series', Genres: ['Anime'] },
          { Id: SER2, Name: 'Drama', Type: 'Series', Genres: ['Drama'] },
          { Id: SER3, Name: 'Quiet', Type: 'Series', Genres: ['Anime'] },
        ] } };
      }
      return { json: { Items: [
        { Id: EP2, Name: 'E2', Type: 'Episode', SeriesId: SERIES, ParentIndexNumber: 1, IndexNumber: 2, PremiereDate: iso(-2) },
        { Id: EP1, Name: 'E1', Type: 'Episode', SeriesId: SERIES, ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: iso(-9) },
        { Id: hex(20), Name: 'D1', Type: 'Episode', SeriesId: SER2, ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: iso(3) },
      ] } };
    },
  });
  admin = await env.login();
  const inv = await env.app.inject({ method: 'POST', url: '/api/admin/invites', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { role: 'friend', ttlHours: 1 } });
  env.claims.current = { sub: 'sub-friend', email: 'f@example.com', name: 'Freund', groups: [] };
  const l = await env.app.inject(`/auth/login?invite=${inv.json().link.split('/').pop()}`);
  const st = l.cookies.find((x) => x.name === 'ff_oidc')!.value;
  const cb = await env.app.inject({ url: `/auth/callback?state=${st}&code=c`, cookies: { ff_oidc: st } });
  const sid = cb.cookies.find((x) => x.name === 'ff_sid')!.value;
  friend = { cookies: { ff_sid: sid }, csrf: (await env.app.inject({ url: '/api/me', cookies: { ff_sid: sid } })).json().csrfToken };
  const jf = (await env.pool.query('select jellyfin_user_id, name from users')).rows;
  watchedBy.add(jf.find((r) => r.name === 'Admin').jellyfin_user_id);
});
afterAll(() => env.close());

describe('helpers', () => {
  it('cleanComment strips control chars, collapses blank lines', () => {
    expect(cleanComment('  a\u0000b\r\n\r\n\r\n\r\nc\u202e ')).toBe('ab\n\nc');
  });
  it('seasonOf / isAnime', () => {
    expect(seasonOf(new Date('2026-10-12T00:00:00Z'))).toEqual({ season: 'fall', year: 2026 });
    expect(seasonOf(new Date('2026-01-01T00:00:00Z')).season).toBe('winter');
    expect(isAnime({ Genres: ['Anime'] })).toBe(true);
    expect(isAnime({ Genres: ['Animation'], ProductionLocations: ['Japan'] })).toBe(true);
    expect(isAnime({ Genres: ['Animation'], ProductionLocations: ['USA'] })).toBe(false);
  });
});

describe('series langpref', () => {
  const url = (id = SERIES) => `/api/series/${id}/langpref`;
  it('requires login and csrf', async () => {
    expect((await env.app.inject(url())).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'PUT', url: url(), cookies: admin.cookies, payload: { audio: 'jpn' } })).statusCode).toBe(403);
  });
  it('empty by default; PUT merges fields; DELETE clears; scoped per profile', async () => {
    expect((await req(admin, 'GET', url())).json()).toEqual({ audio: null, subtitle: null });
    expect((await req(admin, 'PUT', url(), { audio: 'JPN' })).json()).toEqual({ audio: 'jpn', subtitle: null });
    expect((await req(admin, 'PUT', url(), { subtitle: 'off' })).json()).toEqual({ audio: 'jpn', subtitle: 'off' });
    expect((await req(admin, 'PUT', url(), { subtitle: 'ger' })).json()).toEqual({ audio: 'jpn', subtitle: 'ger' });
    expect((await req(friend, 'GET', url())).json()).toEqual({ audio: null, subtitle: null });
    // an episode id resolves to its series
    expect((await req(admin, 'GET', url(EP1))).json()).toEqual({ audio: 'jpn', subtitle: 'ger' });
    expect((await req(admin, 'PUT', url(), { audio: null })).json()).toEqual({ audio: null, subtitle: 'ger' });
    expect((await req(admin, 'DELETE', url())).json()).toEqual({ audio: null, subtitle: null });
    expect((await req(admin, 'GET', url())).json()).toEqual({ audio: null, subtitle: null });
  });
  it('?anime=1 also says whether the series is an anime (for the "original audio with subtitles" setting)', async () => {
    expect((await req(admin, 'GET', `${url()}?anime=1`)).json()).toEqual({ audio: null, subtitle: null, anime: true });
    expect((await req(admin, 'GET', `${url(EP1)}?anime=1`)).json()).toMatchObject({ anime: true }); // episode -> its series
    expect((await req(admin, 'GET', `${url(SER2)}?anime=1`)).json()).toEqual({ audio: null, subtitle: null, anime: false });
    expect((await req(admin, 'GET', `${url(MOVIE)}?anime=1`)).json()).toEqual({ audio: null, subtitle: null, anime: false });
    expect((await req(admin, 'GET', `${url(HIDDEN)}?anime=1`)).statusCode).toBe(404);
    expect((await req(admin, 'GET', `${url()}?anime=yes`)).statusCode).toBe(400);
    expect((await req(admin, 'GET', url())).json()).not.toHaveProperty('anime'); // only when asked
  });
  it('validates input, unsupported types, invisible items', async () => {
    expect((await req(admin, 'PUT', url(), { audio: '<script>' })).statusCode).toBe(400);
    expect((await req(admin, 'PUT', url(), {})).statusCode).toBe(400);
    expect((await req(admin, 'PUT', url(MOVIE), { audio: 'jpn' })).statusCode).toBe(400);
    expect((await req(admin, 'GET', url(MOVIE))).json()).toEqual({ audio: null, subtitle: null });
    expect((await req(admin, 'GET', url(HIDDEN))).statusCode).toBe(404);
    expect((await req(admin, 'PUT', url(HIDDEN), { audio: 'jpn' })).statusCode).toBe(404);
  });
});

describe('simulcast', () => {
  it('requires login', async () => expect((await env.app.inject('/api/simulcast')).statusCode).toBe(401));
  it('groups continuing series with recent episodes by weekday; anime filter', async () => {
    const j = (await req(admin, 'GET', '/api/simulcast')).json();
    expect(j.total).toBe(2); // SER3 has no recent episode
    expect(j.days).toHaveLength(7);
    const all = j.days.flatMap((d: any) => d.items);
    const aoi = all.find((e: any) => e.item.id === SERIES);
    expect(aoi.latest.id).toBe(EP2);
    expect(aoi.anime).toBe(true);
    expect(aoi.weekday).toBe(new Date(iso(-2)).getUTCDay());
    expect(j.days[aoi.weekday].items.map((e: any) => e.item.id)).toContain(SERIES);
    const drama = all.find((e: any) => e.item.id === SER2);
    expect(drama.next.id).toBe(hex(20));
    expect(drama.latest).toBeUndefined();
    const only = (await req(admin, 'GET', '/api/simulcast?anime=1')).json();
    expect(only.total).toBe(1);
    expect((await req(admin, 'GET', '/api/simulcast?anime=x')).statusCode).toBe(400);
  });
});

describe('episode comments', () => {
  const url = (id = EP1) => `/api/items/${id}/comments`;
  let cid = '';
  it('requires login', async () => expect((await env.app.inject(url())).statusCode).toBe(401));
  it('POST validates, stores plain text, flags spoiler by author watched state', async () => {
    expect((await req(admin, 'POST', url(), { body: '   ' })).statusCode).toBe(400);
    expect((await req(admin, 'POST', url(), { body: 'x'.repeat(1001) })).statusCode).toBe(400);
    expect((await req(admin, 'POST', url(), {})).statusCode).toBe(400);
    expect((await req(admin, 'POST', url(HIDDEN), { body: 'hi' })).statusCode).toBe(404);
    expect((await req(admin, 'POST', url(SERIES), { body: 'hi' })).statusCode).toBe(400);
    const r = await req(admin, 'POST', url(), { body: '  <img src=x onerror=alert(1)> Plot twist!  ' });
    expect(r.statusCode).toBe(200);
    cid = r.json().id;
    expect(r.json()).toMatchObject({ body: '<img src=x onerror=alert(1)> Plot twist!', mine: true, name: 'Admin', spoiler: false, canDelete: true });
    expect((await env.pool.query('select spoiler from episode_comments where id=$1', [cid])).rows[0].spoiler).toBe(false); // author watched it
    const f = await req(friend, 'POST', url(), { body: 'Ich habe es noch nicht gesehen' });
    expect(f.json().spoiler).toBe(false); // own comments are never hidden
    expect((await env.pool.query('select spoiler from episode_comments where id=$1', [f.json().id])).rows[0].spoiler).toBe(true);
  });
  it('unwatched reader: every comment of others comes without body until revealed, also one by an author who watched it', async () => {
    // the admin watched EP1 when writing (stored spoiler flag false): exactly the comment that spoils, so it is hidden all the same
    expect((await env.pool.query('select spoiler from episode_comments where id=$1', [cid])).rows[0].spoiler).toBe(false);
    const l = (await req(friend, 'GET', url())).json();
    expect(l.watched).toBe(false);
    const c = l.comments.find((x: any) => x.id === cid);
    expect(c).toMatchObject({ spoiler: true, name: 'Admin', mine: false, canDelete: false });
    expect(c.body).toBeUndefined();
    expect(JSON.stringify(l)).not.toContain('Plot twist');
    expect(l.comments.find((x: any) => x.mine)).toMatchObject({ spoiler: false, body: 'Ich habe es noch nicht gesehen' }); // own: never hidden
    const rev = (await req(friend, 'GET', url() + '?reveal=1')).json();
    expect(rev.comments.find((x: any) => x.id === cid).body).toContain('Plot twist');
    // a reader who watched it sees everything, also comments of people who had not watched it
    const a = (await req(admin, 'GET', url())).json();
    expect(a.watched).toBe(true);
    expect(a.comments).toHaveLength(2);
    expect(a.comments.every((x: any) => !x.spoiler && x.body)).toBe(true);
  });
  it('only author or admin may delete; deleted comments vanish', async () => {
    expect((await req(friend, 'DELETE', `/api/comments/${cid}`)).statusCode).toBe(403);
    expect((await req(friend, 'DELETE', '/api/comments/nope')).statusCode).toBe(404);
    const mine = (await req(friend, 'GET', url())).json().comments.find((x: any) => x.mine);
    expect((await req(friend, 'DELETE', `/api/comments/${mine.id}`)).json()).toEqual({ ok: true });
    expect((await req(admin, 'GET', url())).json().comments.some((x: any) => x.id === mine.id)).toBe(false);
    const f2 = await req(friend, 'POST', url(), { body: 'noch eins' });
    // another profile of the admin account is no moderator: no delete button, 403
    const pr = await req(admin, 'POST', '/api/profiles', { name: 'Gast2' });
    expect(pr.statusCode, pr.body).toBe(201);
    const sw = await req(admin, 'POST', `/api/profiles/${pr.json().profile.id}/select`, {});
    const other = { cookies: { ff_sid: sw.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: admin.csrf };
    expect((await req(other, 'GET', url())).json().comments.find((x: any) => x.id === f2.json().id).canDelete).toBe(false);
    expect((await req(other, 'DELETE', `/api/comments/${f2.json().id}`)).statusCode).toBe(403);
    const back = await req(other, 'POST', `/api/profiles/${(await env.pool.query("select id from users where name='Admin'")).rows[0].id}/select`, {});
    admin = { cookies: { ff_sid: back.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: admin.csrf };
    expect((await req(admin, 'GET', url())).json().comments.find((x: any) => x.id === f2.json().id).canDelete).toBe(true);
    expect((await req(admin, 'DELETE', `/api/comments/${f2.json().id}`)).statusCode).toBe(200); // admin on the owner profile
    expect((await req(admin, 'DELETE', `/api/comments/${f2.json().id}`)).statusCode).toBe(404);
  });
  it('disabled users and guests are not part of the friend circle', async () => {
    await env.pool.query("update users set role='guest' where name='Freund'");
    expect((await req(friend, 'POST', url(), { body: 'gast' })).statusCode).toBe(403);
    expect((await req(friend, 'GET', url())).json().comments).toEqual([]);
    await env.pool.query("update users set role='friend' where name='Freund'");
    await req(friend, 'POST', url(MOVIE), { body: 'film' });
    await env.pool.query("update users set disabled=true where name='Freund'");
    expect((await req(admin, 'GET', url(MOVIE))).json().comments).toEqual([]);
    await env.pool.query("update users set disabled=false where name='Freund'");
  });
  it('rate limits writes per profile per day', async () => {
    await env.pool.query(
      `insert into episode_comments(item_id, profile_id, user_id, body) select $1, p.id, p.user_id, 'x' from profiles p join users u on u.id=p.user_id and u.name='Admin', generate_series(1,200)`, [EP2]);
    expect((await req(admin, 'POST', url(), { body: 'zu viel' })).statusCode).toBe(429);
  });
});
