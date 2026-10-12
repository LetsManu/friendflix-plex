import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { digestTick, resetDigestState, slotFor, weekKey } from '../src/digest.js';
import { cfg, ENC_KEY, makeEnv, type TestEnv } from './helpers.js';
import { keyFromBase64 } from '../src/crypto.js';

type Sess = { cookies: Record<string, string>; csrf: string };
const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
const hidden = new Set<string>();
let created: Array<Record<string, unknown>> = [];
let nextUp: Array<Record<string, unknown>> = [];
let env: TestEnv;
let admin: Sess;
let adminId: string;
let friendId: string;

const SLOT_DAY = 0;
const SLOT_HOUR = 18;
// a fixed "now": 30 minutes after the weekly slot (local time)
const now = slotFor(new Date(2026, 9, 14, 12), SLOT_DAY, SLOT_HOUR);
now.setMinutes(30);
const recent = () => new Date(now.getTime() - 2 * 24 * 3600_000).toISOString();
const old = () => new Date(now.getTime() - 20 * 24 * 3600_000).toISOString();
const movie = (c: string, n: string, when = recent()) => ({ Id: c.repeat(32), Name: n, Type: 'Movie', ProductionYear: 2025, DateCreated: when, UserData: {} });
const episode = (c: string, series: string, sName: string, idx: number) => ({ Id: c.repeat(32), Name: `Folge ${idx}`, Type: 'Episode', SeriesId: series.repeat(32), SeriesName: sName, ParentIndexNumber: 1, IndexNumber: idx, DateCreated: recent(), UserData: {} });

const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const digestNotes = async (uid?: string) => (await env.pool.query("select * from notifications where kind='digest' and ($1::uuid is null or user_id=$1)", [uid ?? null])).rows;
const setPrefs = (uid: string, data: object) => env.pool.query('insert into user_prefs(user_id, data) values ($1,$2) on conflict (user_id) do update set data=excluded.data', [uid, JSON.stringify(data)]);

beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': (u) => {
      const ids = u.searchParams.get('ids');
      if (ids) return { json: { Items: created.filter((i) => ids.split(',').includes(i.Id as string) && !hidden.has(i.Id as string)).map((i) => ({ ...i, UserData: {} })), TotalRecordCount: 1 } };
      const start = Number(u.searchParams.get('startIndex') ?? 0);
      const all = [...created].sort((a, b) => String(b.DateCreated).localeCompare(String(a.DateCreated)));
      return { json: { Items: all.slice(start, start + 200), TotalRecordCount: all.length } };
    },
    'GET /Shows/NextUp': () => ({ json: { Items: nextUp } }),
  }, {
    ctxPatch: (c) => {
      c.cfg = { ...cfg, NTFY_URL: 'https://ntfy.example.com/ff', DISCORD_WEBHOOK_URL: 'https://discord.example.com/hook', DIGEST_DAY: SLOT_DAY, DIGEST_HOUR: SLOT_HOUR };
      c.fetchImpl = (async (u: string, init: RequestInit) => { sent.push({ url: String(u), body: String(init.body), headers: init.headers as Record<string, string> }); return new Response('ok'); }) as unknown as typeof fetch;
    },
  });
  admin = await env.login();
  adminId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub='sub-admin'")).rows[0]!.id;
  friendId = (await env.pool.query<{ id: string }>(
    `insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values (gen_random_uuid(), 'f1', 'f@x.de', 'Freund', 'user', $1, 'freund', $2) returning id`,
    ['9'.repeat(32), encrypt(keyFromBase64(ENC_KEY), 'pw')])).rows[0]!.id;
});
afterAll(() => env.close());
beforeEach(async () => {
  sent.length = 0;
  resetDigestState();
  hidden.clear();
  nextUp = [];
  created = [movie('a', 'Neuer Film'), movie('b', 'Alter Film', old())];
  await env.pool.query('delete from digests; delete from notifications; delete from user_prefs; delete from series_follows; delete from app_settings; delete from recommendations; delete from ratings');
});

describe('schedule helpers', () => {
  it('slotFor returns the latest slot at or before now', () => {
    const wed = new Date(2026, 9, 14, 12, 0); // Wednesday
    const s = slotFor(wed, 0, 18);
    expect(s.getDay()).toBe(0);
    expect(s.getHours()).toBe(18);
    expect(s.getTime()).toBeLessThanOrEqual(wed.getTime());
    expect(wed.getTime() - s.getTime()).toBeLessThan(7 * 24 * 3600_000);
    // exactly at the slot: itself; one minute before: the week before
    expect(slotFor(s, 0, 18).getTime()).toBe(s.getTime());
    expect(slotFor(new Date(s.getTime() - 60_000), 0, 18).getTime()).toBe(s.getTime() - 7 * 24 * 3600_000);
    // same weekday, earlier hour -> previous week
    const sunMorning = new Date(s.getFullYear(), s.getMonth(), s.getDate(), 9);
    expect(slotFor(sunMorning, 0, 18).getDate()).toBe(new Date(s.getTime() - 7 * 24 * 3600_000).getDate());
  });
  it('weekKey is the local YYYY-MM-DD', () => {
    expect(weekKey(new Date(2026, 0, 4, 18))).toBe('2026-01-04');
    expect(weekKey(new Date(2026, 11, 31, 23))).toBe('2026-12-31');
  });
});

describe('digestTick', () => {
  it('sends once per user and week, idempotent across ticks', async () => {
    expect(await digestTick(env.ctx, now)).toBe(2);
    expect(await digestTick(env.ctx, now)).toBe(0);
    expect(await digestTick(env.ctx, new Date(now.getTime() + 3600_000))).toBe(0);
    const notes = await digestNotes();
    expect(notes).toHaveLength(2);
    expect(notes[0].title).toBe('Dein Wochenrückblick: 1 neuer Film');
    expect(notes[0].link).toBe('/digest');
    expect(notes[0].dedupe).toMatch(/^digest-.*-\d{4}-\d{2}-\d{2}$/);
    expect((await env.pool.query('select count(*) n from digests')).rows[0].n).toBe('2');
  });

  it('a lost digests row cannot double-notify (dedupe), and the next week is a new digest', async () => {
    await digestTick(env.ctx, now);
    await env.pool.query('delete from digests');
    await digestTick(env.ctx, now); // "restart" after losing the claim
    expect(await digestNotes()).toHaveLength(2);
    const next = new Date(now.getTime() + 7 * 24 * 3600_000);
    created = [movie('c', 'Noch ein Film', new Date(next.getTime() - 3600_000).toISOString())];
    expect(await digestTick(env.ctx, next)).toBe(2);
    expect(await digestNotes()).toHaveLength(4);
  });

  it('does nothing outside the 24 h after the slot, when off, or disabled by admin', async () => {
    expect(await digestTick(env.ctx, new Date(now.getTime() + 25 * 3600_000))).toBe(0);
    env.ctx.cfg = { ...env.ctx.cfg, DIGEST_HOUR: -1 };
    expect(await digestTick(env.ctx, now)).toBe(0);
    env.ctx.cfg = { ...env.ctx.cfg, DIGEST_HOUR: SLOT_HOUR };
    await env.pool.query(`insert into app_settings(key, value) values ('digest', '{"enabled":false,"day":0,"hour":18}')`);
    expect(await digestTick(env.ctx, now)).toBe(0);
    expect(await digestNotes()).toHaveLength(0);
  });

  it('respects the weekly opt-out and disabled accounts', async () => {
    await setPrefs(friendId, { weeklyDigest: false });
    expect(await digestTick(env.ctx, now)).toBe(1);
    expect(await digestNotes(friendId)).toHaveLength(0);
    await env.pool.query('delete from digests; delete from notifications');
    await setPrefs(friendId, { weeklyDigest: true });
    await env.pool.query('update users set disabled=true where id=$1', [friendId]);
    expect(await digestTick(env.ctx, now)).toBe(1);
    await env.pool.query('update users set disabled=false where id=$1', [friendId]);
  });

  it('an empty week creates no row and no notification', async () => {
    created = [movie('b', 'Alter Film', old())];
    expect(await digestTick(env.ctx, now)).toBe(0);
    expect((await env.pool.query('select count(*) n from digests')).rows[0].n).toBe('0');
    expect(await digestNotes()).toHaveLength(0);
  });

  it('groups episodes per series and flags followed series (follow or next up)', async () => {
    created = [episode('1', 'f', 'Gefolgt', 1), episode('2', 'f', 'Gefolgt', 2), episode('3', 'e', 'Weiter', 1), ...Array.from({ length: 7 }, (_, i) => episode(String(i + 4), 'd', 'Fremd', i + 1))];
    await env.pool.query("insert into series_follows(user_id, series_id, series_name) values ($1,$2,'Gefolgt')", [adminId, 'f'.repeat(32)]);
    nextUp = [{ Id: '3'.repeat(32), Name: 'x', Type: 'Episode', SeriesId: 'e'.repeat(32), UserData: {} }];
    await digestTick(env.ctx, now);
    const d = (await env.pool.query('select data from digests where user_id=$1', [adminId])).rows[0].data;
    expect(d.newEpisodeCount).toBe(10);
    const by = Object.fromEntries(d.newEpisodes.map((g: any) => [g.seriesName, g]));
    expect(by.Gefolgt).toMatchObject({ count: 2, followed: true });
    expect(by.Weiter.followed).toBe(true);
    expect(by.Fremd).toMatchObject({ count: 7, followed: false });
    expect(by.Fremd.episodes).toHaveLength(5);
    expect(d.newEpisodes[2].seriesName).toBe('Fremd'); // followed first
    const friend = (await env.pool.query('select data from digests where user_id=$1', [friendId])).rows[0].data;
    expect(friend.newEpisodes.every((g: any) => g.seriesName === 'Weiter' ? g.followed : true)).toBe(true); // nextUp stub is shared by the fake
  });

  it('includes availability notices, recommendations and friends ratings of the window', async () => {
    created = [];
    await env.pool.query(
      `insert into notifications(user_id, kind, title, link, dedupe, created_at) values ($1,'available','„Dunmoor“ ist jetzt verfügbar',$2,'t1',$3), ($1,'reminder','„Alt“ ist jetzt verfügbar','/requests','t2',$4)`,
      [adminId, `/item/${'c'.repeat(32)}`, recent(), old()]);
    await env.pool.query("insert into recommendations(from_user,to_user,item_id,item_name,note,created_at) values ($1,$2,$3,'Hearth','top',$4)", [friendId, adminId, 'd'.repeat(32), recent()]);
    await env.pool.query("insert into ratings(user_id,item_id,item_name,stars,created_at) values ($1,$2,'Ashfall',5,$3)", [friendId, 'e'.repeat(32), recent()]);
    expect(await digestTick(env.ctx, now)).toBe(1); // only the admin has anything
    const d = (await env.pool.query('select data from digests where user_id=$1', [adminId])).rows[0].data;
    expect(d.available).toEqual([{ title: '„Dunmoor“ ist jetzt verfügbar', link: `/item/${'c'.repeat(32)}`, itemId: 'c'.repeat(32) }]);
    expect(d.recommendations.map((r: any) => [r.name, r.kind])).toEqual([['Hearth', 'recommended'], ['Ashfall', 'friends']]);
    expect((await digestNotes(adminId))[0].title).toBe('Dein Wochenrückblick');
  });
});

describe('personal push', () => {
  it('posts only to the user topic on the ntfy host, never to Discord or the global topic', async () => {
    await setPrefs(adminId, { ntfyTopic: 'mein-topic_1' });
    await digestTick(env.ctx, now);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://ntfy.example.com/mein-topic_1');
    expect(sent[0]!.url).not.toMatch(/discord|\/ff$/);
    expect(sent[0]!.headers.Click).toBe('https://portal.example.com/digest');
  });
  it('uses NTFY_BASE_URL when set and sends nothing without a topic or ntfy server', async () => {
    await digestTick(env.ctx, now);
    expect(sent).toHaveLength(0);
    await env.pool.query('delete from digests; delete from notifications');
    await setPrefs(adminId, { ntfyTopic: 'abc' });
    env.ctx.cfg = { ...env.ctx.cfg, NTFY_BASE_URL: 'https://push.example.org/base' };
    await digestTick(env.ctx, now);
    expect(sent.map((s) => s.url)).toEqual(['https://push.example.org/base/abc']);
    await env.pool.query('delete from digests; delete from notifications');
    sent.length = 0;
    env.ctx.cfg = { ...env.ctx.cfg, NTFY_BASE_URL: undefined, NTFY_URL: undefined };
    await digestTick(env.ctx, now);
    expect(sent).toHaveLength(0);
    env.ctx.cfg = { ...env.ctx.cfg, NTFY_URL: 'https://ntfy.example.com/ff' };
  });
});

describe('privacy of the texts', () => {
  it('in-app body has counts only; titles only in the personal push', async () => {
    created = [movie('a', 'Geheimfilm'), episode('1', 'f', 'Geheimserie', 1), episode('2', 'f', 'Geheimserie', 2)];
    await setPrefs(adminId, { ntfyTopic: 'privat' });
    await digestTick(env.ctx, now);
    const n = (await digestNotes(adminId))[0];
    expect(`${n.title}\n${n.body}`).not.toMatch(/Geheim/);
    expect(n.body).toMatch(/1 neuer Film/);
    expect(n.body).toMatch(/2 neue Folgen in 1 Serie/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatch(/Geheimfilm/);
    expect(sent[0]!.body).toMatch(/Geheimserie/);
  });
  it('caps series groups at 20 but keeps the totals', async () => {
    created = Array.from({ length: 25 }, (_, i) => episode(i.toString(16).padStart(2, '0')[0]!, String.fromCharCode(97 + (i % 6)), `S${i}`, i)).map((e, i) => ({ ...e, Id: String(i).padStart(2, '0').repeat(16), SeriesId: String(i + 10).padStart(2, '0').repeat(16), SeriesName: `S${i}` }));
    await digestTick(env.ctx, now);
    const d = (await env.pool.query('select data from digests where user_id=$1', [adminId])).rows[0].data;
    expect(d.newEpisodes).toHaveLength(20);
    expect(d.newEpisodeCount).toBe(25);
    expect(Object.keys(d.seriesCounts)).toHaveLength(25);
  });
});

describe('GET /api/digest/latest', () => {
  it('returns full item DTOs and counts only visible movies beyond the 12 shown', async () => {
    created = Array.from({ length: 15 }, (_, i) => movie(i.toString(16), `Film ${i}`));
    created = created.map((m, i) => ({ ...m, Id: String(i).padStart(2, '0').repeat(16) }));
    await digestTick(env.ctx, now);
    hidden.add('13'.repeat(16)); // not among the 12 shown names
    hidden.add('00'.repeat(16)); // shown
    const r = (await call(admin, 'GET', '/api/digest/latest')).json().digest;
    expect(r.data.newMovieCount).toBe(13);
    expect(r.data.newMovies).toHaveLength(11);
    expect(r.data.movieIds).toBeUndefined();
    expect(r.items['01'.repeat(16)]).toMatchObject({ id: '01'.repeat(16), name: 'Film 1', type: 'Movie' });
    expect(r.items['00'.repeat(16)]).toBeUndefined();
  });

  it('null without a digest; drops items the profile cannot see', async () => {
    expect((await call(admin, 'GET', '/api/digest/latest')).json()).toEqual({ digest: null });
    created = [movie('a', 'Sichtbar'), movie('b', 'Versteckt'), episode('1', 'f', 'Serie', 1), episode('2', 'f', 'Serie', 2)];
    created.push({ Id: 'f'.repeat(32), Name: 'Serie', Type: 'Series', DateCreated: old(), UserData: {} });
    await digestTick(env.ctx, now);
    hidden.add('b'.repeat(32));
    hidden.add('2'.repeat(32));
    const r = (await call(admin, 'GET', '/api/digest/latest')).json().digest;
    expect(r.week).toBe(weekKey(slotFor(now, SLOT_DAY, SLOT_HOUR)));
    expect(r.data.newMovies.map((m: any) => m.name)).toEqual(['Sichtbar']);
    expect(r.data.newMovieCount).toBe(1);
    expect(r.data.newEpisodes[0].episodes.map((e: any) => e.id)).toEqual(['1'.repeat(32)]);
    expect(r.data.newEpisodeCount).toBe(1);
    hidden.add('f'.repeat(32));
    expect((await call(admin, 'GET', '/api/digest/latest')).json().digest.data.newEpisodes).toEqual([]);
  });
});

describe('admin settings', () => {
  it('GET shows the config defaults, PUT overrides and audits, non-admin gets 403', async () => {
    const g = (await call(admin, 'GET', '/api/admin/digest')).json();
    expect(g).toMatchObject({ enabled: true, day: SLOT_DAY, hour: SLOT_HOUR, source: 'config', lastRun: null });
    const p = await call(admin, 'PUT', '/api/admin/digest', { enabled: true, day: 5, hour: 20 });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({ day: 5, hour: 20, source: 'admin' });
    expect((await call(admin, 'PUT', '/api/admin/digest', { enabled: true, day: 7, hour: 20 })).statusCode).toBe(400);
    expect((await call(admin, 'PUT', '/api/admin/digest', { enabled: true, day: 1, hour: -1 })).statusCode).toBe(400);
    expect((await env.pool.query("select 1 from audit_log where action='digest.settings'")).rowCount).toBe(1);
    await call(admin, 'PUT', '/api/admin/digest', { enabled: true, day: SLOT_DAY, hour: SLOT_HOUR });
    await digestTick(env.ctx, now);
    expect((await call(admin, 'GET', '/api/admin/digest')).json().lastRun).toMatchObject({ count: 2 });

    const user = await env.login({ sub: 'f1', email: 'f@x.de', name: 'Freund', groups: [] });
    expect((await call(user, 'GET', '/api/admin/digest')).statusCode).toBe(403);
    expect((await call(user, 'PUT', '/api/admin/digest', { enabled: false, day: 1, hour: 1 })).statusCode).toBe(403);
    expect((await call(user, 'POST', '/api/admin/digest/test')).statusCode).toBe(403);
  });

  it('test endpoint sends a fresh digest to the caller without storing a row', async () => {
    await setPrefs(adminId, { ntfyTopic: 'testing' });
    const a = (await call(admin, 'POST', '/api/admin/digest/test')).json();
    expect(a.sent).toBe(true);
    expect(a.data).not.toBeNull();
    expect(sent.map((s) => s.url)).toContain('https://ntfy.example.com/testing');
    expect((await env.pool.query('select count(*) n from digests')).rows[0].n).toBe('0');
    const b = (await call(admin, 'POST', '/api/admin/digest/test')).json();
    expect(b.sent).toBe(true); // unique dedupe per test
  });
});

describe('prefs', () => {
  it('stores weeklyDigest/ntfyTopic at account level, validates the topic, owner profile only', async () => {
    const base = (await call(admin, 'GET', '/api/prefs')).json().prefs;
    expect(base).toMatchObject({ weeklyDigest: true, ntfyTopic: '' });
    expect((await call(admin, 'PUT', '/api/prefs', { ...base, ntfyTopic: 'bad topic!' })).statusCode).toBe(400);
    expect((await call(admin, 'PUT', '/api/prefs', { ...base, ntfyTopic: 'x'.repeat(65) })).statusCode).toBe(400);
    // the global NTFY_URL topic (…/ff) is shared: refuse it as personal topic
    expect((await call(admin, 'PUT', '/api/prefs', { ...base, ntfyTopic: 'ff' })).statusCode).toBe(400);
    const ok = await call(admin, 'PUT', '/api/prefs', { ...base, ntfyTopic: 'mein-topic', weeklyDigest: false, shareHistory: true });
    expect(ok.json().prefs).toMatchObject({ ntfyTopic: 'mein-topic', weeklyDigest: false, shareHistory: true });
    expect((await env.pool.query('select data from user_prefs where user_id=$1', [adminId])).rows[0].data).toMatchObject({ ntfyTopic: 'mein-topic', weeklyDigest: false, shareHistory: true });

    const pr = await call(admin, 'POST', '/api/profiles', { name: 'Kind' });
    expect(pr.statusCode).toBe(201);
    const sel = await call(admin, 'POST', `/api/profiles/${pr.json().profile.id}/select`, {});
    const kid: Sess = { cookies: { ff_sid: sel.cookies.find((c) => c.name === 'ff_sid')!.value }, csrf: admin.csrf };
    const mine = (await call(kid, 'GET', '/api/prefs')).json().prefs;
    expect(mine).toMatchObject({ ntfyTopic: '', weeklyDigest: false }); // the account's topic is not shown to other profiles
    const put = await call(kid, 'PUT', '/api/prefs', { ...mine, ntfyTopic: 'kid-topic', weeklyDigest: true, autoplayNext: false });
    expect(put.json().prefs).toMatchObject({ ntfyTopic: '', weeklyDigest: false, autoplayNext: false });
    expect((await env.pool.query('select data from user_prefs where user_id=$1', [adminId])).rows[0].data).toMatchObject({ ntfyTopic: 'mein-topic', weeklyDigest: false });
  });
});
