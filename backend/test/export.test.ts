// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { listErrors } from '../src/errorlog.js';
import { m } from '../src/i18n.js';
import { notify, notifyAdmins } from '../src/notify.js';
import type { ItemDto } from '../src/media/types.js';
import { cfg, makeEnv, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
let env: TestEnv;
afterEach(async () => { const e = env; env = undefined as unknown as TestEnv; await e?.close(); });

const get = (s: Sess, url = '/api/account/export') => env.app.inject({ method: 'GET', url, cookies: s.cookies });
const item = (id: string, name: string, extra: Partial<ItemDto> = {}): ItemDto => ({
  id, name, type: 'Movie', genres: [], image: true, backdrop: false, logo: false, trailers: 0, played: true, favorite: false, positionTicks: 0,
  lastPlayedDate: '2026-10-01T20:00:00.000Z', ...extra,
});

/** every key and every string value of a parsed JSON tree */
function walk(v: unknown, keys: string[] = [], values: string[] = []): { keys: string[]; values: string[] } {
  if (Array.isArray(v)) for (const x of v) walk(x, keys, values);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x, keys, values); }
  else if (typeof v === 'string') values.push(v);
  return { keys, values };
}

interface Seed {
  a: string; aKid: string; b: string; bOwner: string; bKid: string;
  secrets: string[]; endpoints: string[];
}

/**
 * A (the logged-in owner, plus a PIN-protected second profile) and B (a second account with two profiles) both get rows in every
 * exported table. B owns a private list and a list A is an editor of; A owns a list B is an editor of and added an item to.
 */
async function seed(): Promise<Seed> {
  const q = (sql: string, p: unknown[] = []) => env.pool.query(sql, p);
  const a = (await q("select id from users where authentik_sub='sub-admin'")).rows[0].id as string;
  await q("update users set avatar='teal', access_until=now() + interval '30 days' where id=$1", [a]);
  const aKid = randomUUID(), b = randomUUID(), bKid = randomUUID();
  const pw = encrypt(env.ctx.encKey, 'pw');
  await q("insert into profiles(id, user_id, name, avatar, pin_hash, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc, kids, kids_max_rating) values ($1,$2,'Kiddo','blue','pinhash-a-secret','jfakid000000000000000000000000ab','ff-akid',$3,true,6)", [aKid, a, pw]);
  await q("insert into users(id, authentik_sub, email, name, role, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1,'sub-bobmark','bobmark@example.com','Bobmark','friend','jfbob00000000000000000000000000b','bobmark-jf',$2)", [b, pw]);
  await q("insert into profiles(id, user_id, name, is_owner) values ($1,$1,'Bobmark',true)", [b]);
  await q("insert into profiles(id, user_id, name, pin_hash, jellyfin_user_id, jellyfin_username, jellyfin_pw_enc) values ($1,$2,'Bobkidmark','pinhash-b-secret','jfbkid00000000000000000000000000b','ff-bkid',$3)", [bKid, b, pw]);
  for (const [u, p, k, tag] of [[a, a, aKid, 'a'], [b, b, bKid, 'b']] as const) {
    await q('insert into watchlist(user_id, profile_id, item_id) values ($1,$2,$3), ($1,$4,$5)', [u, p, `${tag}item-watch`, k, `${tag}item-watch-kid`]);
    await q('insert into ratings(user_id, item_id, item_name, stars, review) values ($1,$2,$3,4,$4)', [u, `${tag}item-rated`, `${tag}title-rated`, `${tag}review-text`]);
    await q('insert into thumbs(user_id, profile_id, item_id, value, item_name) values ($1,$2,$3,1,$4)', [u, k, `${tag}item-thumb`, `${tag}title-thumb`]);
    await q('insert into bookmarks(id, user_id, profile_id, item_id, item_name, position_sec, note) values ($1,$2,$3,$4,$5,90,$6)', [randomUUID(), u, p, `${tag}item-bm`, `${tag}title-bm`, `${tag}bm-note`]);
    await q("insert into reminders(user_id, profile_id, kind, media_type, tmdb_id, title) values ($1,$2,'tmdb','movie',$3,$4)", [u, p, tag === 'a' ? 101 : 202, `${tag}title-reminder`]);
    await q('insert into series_follows(user_id, series_id, series_name) values ($1,$2,$3)', [u, `${tag}series-followed`, `${tag}title-series`]);
    await q("insert into reactions(user_id, profile_id, item_id, emoji, comment) values ($1,$2,$3,'wow',$4)", [u, p, `${tag}item-reacted`, `${tag}reaction-comment`]);
    await q("insert into play_seconds(user_id, item_id, day, seconds, item_name, item_type) values ($1,$2,'2026-10-01',600,$3,'Movie'), ($1,$2,'2026-10-02',300,$3,'Movie')", [u, `${tag}item-played`, `${tag}title-played`]);
    await q(`insert into seerr_requests(seerr_request_id, user_id, media_type, tmdb_id, title) values ($1,$2,'movie',$3,$4)`, [tag === 'a' ? 11 : 22, u, tag === 'a' ? 1111 : 2222, `${tag}title-request`]);
    await q('insert into devices(user_id, device_id, label, approved) values ($1,$2,$3,true) on conflict do nothing', [u, `${tag}dev-secret-id-000001`, `${tag}device-label`]);
    await q("insert into play_daily(user_id, day, device_id, streams, transcodes) values ($1,'2026-10-01',$2,3,1)", [u, `${tag}dev-secret-id-000001`]);
    await q('insert into push_subscriptions(user_id, device_id, profile_id, endpoint, p256dh, auth) values ($1,$2,$3,$4,$5,$6)',
      [u, `${tag}dev-secret-id-000001`, p, `https://push.example.com/${tag}-endpoint-secret`, `${tag}p256dh-secret`, `${tag}auth-secret`]);
    await q("insert into notifications(user_id, kind, title, dedupe, read_at) values ($1,'info',$2,$3,now()), ($1,'info',$4,null,null)", [u, `${tag}notice-read`, `${tag}-dedupe-1`, `${tag}notice-unread`]);
    await q(`insert into user_prefs(user_id, data) values ($1,$2) on conflict (user_id) do update set data=excluded.data`, [u, JSON.stringify({ weeklyDigest: false, ntfyTopic: `${tag}ntfy-topic-secret`, shareRatings: true })]);
    // both comment on the same item
    await q("insert into episode_comments(item_id, profile_id, user_id, body) values ('shared-item',$1,$2,$3)", [p, u, `${tag}comment-body`]);
    await q('insert into achievements(user_id, key) values ($1,$2)', [u, `${tag}key-achievement`]);
    await q("insert into series_langprefs(profile_id, series_id, audio, subtitle) values ($1,$2,'jpn','ger')", [k, `${tag}series-lang`]);
    await q('insert into resume_hidden(profile_id, item_id) values ($1,$2)', [p, `${tag}item-hidden`]);
  }
  // recommendations both ways: A's export shows only what A sent, without the recipient
  await q("insert into recommendations(from_user, to_user, item_id, item_name, note, seen) values ($1,$2,'aitem-rec','A rec title','a-rec-note',true), ($2,$1,'bitem-rec','B rec title','bobmark-rec-note',false)", [a, b]);
  // a poll by B ("Bobmark movie night") and one by A; both vote in both
  const pollB = randomUUID(), pollA = randomUUID();
  await q("insert into polls(id, title, created_by, closes_at, starts_at) values ($1,'Bobmark movie night',$2,now()+interval '1 day',now()+interval '2 days'), ($3,'A poll',$4,now()+interval '1 day',now()+interval '2 days')", [pollB, b, pollA, a]);
  const opt = async (poll: string, title: string) => (await q('insert into poll_options(poll_id, title) values ($1,$2) returning id', [poll, title])).rows[0].id as string;
  const [ob1, ob2, oa1, oa2] = [await opt(pollB, 'Option shared'), await opt(pollB, 'Option bobpick'), await opt(pollA, 'Option apick'), await opt(pollA, 'Option bobpick-a')];
  await q('insert into poll_votes(poll_id, user_id, option_id) values ($1,$2,$3), ($1,$4,$5), ($6,$2,$7), ($6,$4,$8)', [pollB, a, ob1, b, ob2, pollA, oa1, oa2]);
  // notices in A's inbox that are rendered with B's name, list and party (A is the admin, so it gets the admin notices too)
  await notify(env.ctx, { userId: a, kind: 'list_invite', title: m('list.invite', { name: 'Bobmark', list: 'Bobmark secret list' }), link: `/lists/${randomUUID()}` });
  await notify(env.ctx, { userId: a, kind: 'party_invite', title: m('party.invite', { name: 'Bobmark', title: 'Bobmark party' }), link: '/party/x' });
  await notify(env.ctx, { userId: a, kind: 'recommend', title: m('recommend', { name: 'Bobmark', title: 'B rec title' }), body: 'bobmark-rec-note', link: '/item/bitem-rec' });
  await notifyAdmins(env.ctx, { kind: 'approval', title: m('notify.approval.new', { name: 'Bobmark' }), link: '/admin/users?tab=approvals' });
  await notifyAdmins(env.ctx, { kind: 'access_soon', title: m('notify.access.soonAdmin', { name: 'Bobmark', date: { date: '2026-10-20' } }), link: '/admin/users', dedupe: `access-soon-admin-${b}-x` });
  await q("insert into notifications(user_id, kind, title) values (null,'info','broadcast-title-other')");
  // lists: A's own (B is editor and added an item with a note), B's private one, B's list shared with A
  const la = randomUUID(), lbPriv = randomUUID(), lbShared = randomUUID();
  await q("insert into lists(id, owner_id, name, description, themed, emoji, cover_color) values ($1,$2,'A favourites','A desc',true,'🎬','#112233')", [la, a]);
  await q("insert into lists(id, owner_id, name) values ($1,$2,'Bobmark secret list'), ($3,$2,'Bobmark shared list')", [lbPriv, b, lbShared]);
  await q("insert into list_members(list_id, user_id, role) values ($1,$2,'editor'), ($3,$4,'editor')", [la, b, lbShared, a]);
  await q("insert into list_items(list_id, item_id, item_name, added_by) values ($1,'aitem-list-own','A own item',$2)", [la, a]);
  await q("insert into list_items(list_id, item_id, item_name, note, added_by) values ($1,'xitem-by-member','Member item','bobmark-note',$2)", [la, b]);
  await q("insert into list_items(list_id, item_id, item_name, added_by) values ($1,'bitem-private-list','B private item',$2)", [lbPriv, b]);
  await q("insert into list_items(list_id, item_id, item_name, added_by) values ($1,'aitem-in-b-list','A item in B list',$2), ($1,'bitem-in-b-list','B item in B list',$3)", [lbShared, a, b]);
  const secrets = (await q('select authentik_sub, jellyfin_pw_enc from users')).rows.flatMap((r) => [r.authentik_sub, r.jellyfin_pw_enc])
    .concat((await q('select jellyfin_pw_enc, pin_hash from profiles where jellyfin_pw_enc is not null or pin_hash is not null')).rows.flatMap((r) => [r.jellyfin_pw_enc, r.pin_hash]).filter(Boolean));
  const endpoints = (await q('select endpoint, p256dh, auth from push_subscriptions')).rows.flatMap((r) => [r.endpoint, r.p256dh, r.auth]);
  return { a, aKid, b, bOwner: b, bKid, secrets, endpoints };
}

/** media server history: one title per profile; records which Jellyfin users were asked */
function fakeHistory(fail = false) {
  const asked: string[] = [];
  env.ctx.jf.history = async (u, q) => {
    asked.push(`${u.jellyfin_user_id}:${q?.start}:${q?.limit}`);
    if (fail) throw new Error('media server down');
    return [item(`hist-${u.jellyfin_user_id.slice(0, 6)}`, `History ${u.jellyfin_user_id.slice(0, 6)}`, { type: 'Episode', seriesName: 'Some Show', positionTicks: 1_200_000_000 })];
  };
  return asked;
}

async function setup() {
  env = await makeEnv({}, { seerr: { 'GET /api/v1/request/\\d+': () => ({ json: { status: 2, media: { status: 5 } } }) } });
  const s = await env.login();
  const seeded = await seed();
  return { s, ...seeded };
}

describe('GET /api/account/export', () => {
  it("export of A contains none of B's ids, names, e-mail, list names or notification titles", async () => {
    const { s, b, bKid } = await setup();
    fakeHistory();
    const r = await get(s);
    expect(r.statusCode).toBe(200);
    const doc = r.json();
    const text = JSON.stringify(doc);
    // the one place B's name may show: the (owner-chosen) name of the list A is an editor of, removed here by its key and path
    const shared = doc.lists.find((l: { owned: boolean }) => !l.owned);
    expect(shared.name).toBe('Bobmark shared list');
    const scrubbed = JSON.stringify({ ...doc, lists: doc.lists.map((l: { owned: boolean }) => (l === shared ? { ...l, name: null } : l)) });
    expect(scrubbed.toLowerCase()).not.toContain('bobmark'); // name, e-mail, list names, notes, poll titles: any substring
    for (const v of [b, bKid, 'Bobmark secret list', 'bnotice-read', 'bnotice-unread', 'broadcast-title-other', 'bcomment-body', 'bkey-achievement', 'bseries-lang',
      'bitem-hidden', 'bitem-rec', 'Option bobpick',
      'bitem-watch', 'bitem-rated', 'bitem-thumb', 'bitem-bm', 'btitle-reminder', 'bseries-followed', 'bitem-reacted', 'bitem-played', '2222', 'bdevice-label',
      'bitem-private-list', 'bitem-in-b-list', 'bobmark-note', 'breview-text', 'bbm-note']) {
      expect(text, v).not.toContain(v);
    }
    // A's own data is all there
    expect(doc).toMatchObject({ format: 'friendflix-export', version: 1 });
    expect(Object.keys(doc)).toEqual(['format', 'version', 'exportedAt', 'account', 'profiles', 'lists', 'watchlist', 'ratings', 'history', 'requests', 'devices', 'notifications',
      'social', 'achievements']);
    expect(doc.account).toMatchObject({ name: 'Admin', email: 'admin@example.com', role: 'admin', avatar: 'teal' });
    expect(Object.keys(doc.account).sort()).toEqual(['accessUntil', 'avatar', 'createdAt', 'email', 'id', 'name', 'role']);
    expect(doc.profiles).toHaveLength(2);
    expect(doc.profiles[1]).toMatchObject({ name: 'Kiddo', kids: true, maxRating: 6, isOwner: false });
    for (const v of ['aitem-watch', 'aitem-watch-kid', 'aitem-rated', 'aitem-thumb', 'aitem-bm', 'atitle-reminder', 'aseries-followed', 'aitem-reacted', 'aitem-played',
      'adevice-label', 'A favourites', 'acomment-body', 'akey-achievement', 'aseries-lang', 'aitem-hidden', 'aitem-rec', 'a-rec-note', 'A poll', 'Option apick', 'Option shared']) {
      expect(text, v).toContain(v);
    }
    expect(doc.requests).toEqual([expect.objectContaining({ tmdbId: 1111, mediaType: 'movie', status: 'available' })]);
    expect(doc.notifications).toMatchObject({ weeklyDigest: false, pushSubscriptions: 1 });
    expect(doc.notifications.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'info', read: true }), expect.objectContaining({ kind: 'info', read: false })]));
    // own rows from shared places
    expect(doc.social.comments).toEqual([expect.objectContaining({ itemId: 'shared-item', body: 'acomment-body', deleted: false })]);
    expect(doc.social.pollVotes).toHaveLength(2);
    expect(doc.social.pollVotes).toEqual(expect.arrayContaining([{ choice: 'Option shared', startsAt: expect.any(String) }, { poll: 'A poll', choice: 'Option apick', startsAt: expect.any(String) }]));
    expect(doc.social.recommendationsSent).toEqual([{ itemId: 'aitem-rec', name: 'A rec title', note: 'a-rec-note', createdAt: expect.any(String) }]);
    expect(doc.achievements).toEqual([{ key: 'akey-achievement', earnedAt: expect.any(String) }]);
    expect(doc.watchlist.seriesLanguages).toEqual([expect.objectContaining({ seriesId: 'aseries-lang', audio: 'jpn', subtitle: 'ger' })]);
    expect(doc.watchlist.hiddenFromResume).toEqual([expect.objectContaining({ itemId: 'aitem-hidden' })]);
  });

  it('notification texts are not exported: invites, recommendations and admin notices name other people', async () => {
    const { s, a } = await setup();
    fakeHistory();
    const r = await get(s);
    const notices = (await env.pool.query('select kind, title, body from notifications where user_id=$1', [a])).rows;
    expect(notices.map((n) => n.title).join(' ')).toContain('Bobmark'); // the seed really rendered B's name into A's inbox
    const doc = r.json();
    expect(doc.notifications.items.map((n: { kind: string }) => n.kind)).toEqual(expect.arrayContaining(['list_invite', 'party_invite', 'recommend', 'approval', 'access_soon']));
    for (const n of doc.notifications.items) expect(Object.keys(n).sort()).toEqual(['createdAt', 'kind', 'read']);
    const shared = doc.lists.find((l: { owned: boolean }) => !l.owned);
    const raw = r.body.replace(JSON.stringify(shared.name), 'null'); // the allowed member-list name, once, by value of that key
    expect(r.body.split('"Bobmark shared list"').length - 1).toBe(1);
    for (const v of ['Bobmark', 'bobmark', 'Bobmark secret list', 'Bobmark party', 'B rec title']) expect(raw, v).not.toContain(v);
  });

  it('export never contains jellyfin_pw_enc, authentik_sub, pin_hash, push endpoints', async () => {
    const { s, secrets, endpoints } = await setup();
    fakeHistory();
    const doc = (await get(s)).json();
    const { keys, values } = walk(doc);
    for (const k of ['jellyfin_pw_enc', 'authentik_sub', 'pin_hash', 'pinHash', 'endpoint', 'p256dh', 'auth', 'deviceId', 'device_id', 'jellyfinUserId', 'jellyfin_user_id', 'ntfyTopic']) {
      expect(keys, k).not.toContain(k);
    }
    const all = values.join('\n');
    for (const v of [...secrets, ...endpoints, 'sub-admin', 'adev-secret-id-000001', 'antfy-topic-secret', 'jfakid000000000000000000000000ab', 'ff-akid']) {
      expect(all, v).not.toContain(v);
    }
  });

  it('owned list with a member\'s item lists the item without the member', async () => {
    const { s, b } = await setup();
    fakeHistory();
    const doc = (await get(s)).json();
    const own = doc.lists.find((l: { name: string }) => l.name === 'A favourites');
    expect(own).toMatchObject({ owned: true, description: 'A desc', themed: true, emoji: '🎬', coverColor: '#112233' });
    expect(own.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: 'aitem-list-own', addedByMe: true }),
      expect.objectContaining({ itemId: 'xitem-by-member', addedByMe: false }),
    ]));
    expect(own.members).toBeUndefined();
    const member = own.items.find((i: { itemId: string }) => i.itemId === 'xitem-by-member');
    expect(Object.keys(member).sort()).toEqual(['addedAt', 'addedByMe', 'itemId', 'name']); // no added_by, no member's note
    // the list A is only a member of: its name and A's own items, nothing of the owner
    const shared = doc.lists.find((l: { name: string }) => l.name === 'Bobmark shared list');
    expect(shared).toEqual({ name: 'Bobmark shared list', owned: false, items: [expect.objectContaining({ itemId: 'aitem-in-b-list', addedByMe: true })] });
    expect(JSON.stringify(doc.lists)).not.toContain(b);
    expect(doc.lists).toHaveLength(2);
  });

  it('history comes from the media server per profile', async () => {
    const { s } = await setup();
    const asked = fakeHistory();
    const doc = (await get(s)).json();
    const jfIds = (await env.pool.query("select jellyfin_user_id from users where authentik_sub='sub-admin'")).rows[0].jellyfin_user_id as string;
    expect(asked.sort()).toEqual([`${jfIds}:0:200`, 'jfakid000000000000000000000000ab:0:200'].sort());
    expect(doc.history.profiles).toHaveLength(2);
    expect(doc.history.profiles[0].items[0]).toEqual({
      itemId: `hist-${jfIds.slice(0, 6)}`, name: `History ${jfIds.slice(0, 6)}`, type: 'Episode', seriesName: 'Some Show',
      playedAt: '2026-10-01T20:00:00.000Z', positionSeconds: 120, played: true,
    });
    // local totals of the user's own rows
    expect(doc.history.totals.perItem).toEqual([expect.objectContaining({ itemId: 'aitem-played', seconds: 900 })]);
    expect(doc.history.totals.perDay).toEqual([{ day: '2026-10-01', streams: 3, transcodes: 1 }]);
  });

  it('history is paged with start up to 1000 per profile, deduped, and marked truncated', async () => {
    const { s, a, aKid } = await setup();
    const jfA = (await env.pool.query('select jellyfin_user_id from users where id=$1', [a])).rows[0].jellyfin_user_id as string;
    const calls: Array<{ start?: number; limit?: number }> = [];
    // 1500 played items; page 0 also carries 10 in-progress items that push played ones out of its 200-item slice
    const played = Array.from({ length: 1500 }, (_, n) => item(`p${n}`, `P${n}`));
    env.ctx.jf.history = async (u, q) => {
      if (u.jellyfin_user_id !== jfA) return [item('k1', 'K1')]; // the kids profile: one short page
      calls.push({ start: q?.start, limit: q?.limit });
      const start = q?.start ?? 0;
      if (start === 0) return [...Array.from({ length: 10 }, (_, n) => item(`r${n}`, `R${n}`, { played: false })), ...played].slice(0, 200);
      return played.slice(start, start + 200);
    };
    const doc = (await get(s)).json();
    expect(calls.map((c) => c.limit).every((l) => l === 200)).toBe(true);
    expect(calls.map((c) => c.start)).toEqual([0, 160, 360, 560, 760, 960]);
    const own = doc.history.profiles.find((p: { profileId: string }) => p.profileId === a);
    const ids = own.items.map((i: { itemId: string }) => i.itemId);
    expect(ids).toHaveLength(1000);
    expect(new Set(ids).size).toBe(1000);
    expect(ids).toContain('p190'); // pushed out of page 0, picked up by the overlapping page 2
    expect(own.truncated).toBe(true);
    expect(doc.history.truncated).toBe(true);
    expect(doc.history.profiles.find((p: { profileId: string }) => p.profileId === aKid)).toEqual({ profileId: aKid, items: [expect.objectContaining({ itemId: 'k1' })] });
  });

  /** the owner identity gets `n` played items by `start` (a page may fail); the kids profile one short page */
  async function servePlayed(a: string, n: number, failAt?: number) {
    const jfA = (await env.pool.query('select jellyfin_user_id from users where id=$1', [a])).rows[0].jellyfin_user_id as string;
    const played = Array.from({ length: n }, (_, k) => item(`p${k}`, `P${k}`));
    const starts: number[] = [];
    env.ctx.jf.history = async (u, q) => {
      if (u.jellyfin_user_id !== jfA) return [item('k1', 'K1')];
      const start = q?.start ?? 0;
      starts.push(start);
      if (start === failAt) throw new Error('timeout');
      return played.slice(start, start + 200);
    };
    return starts;
  }
  type HistoryEntry = { profileId: string; items: Array<{ itemId: string }>; truncated?: boolean; error?: string };
  const ownHistory = (doc: { history: { profiles: HistoryEntry[] } }, a: string) => doc.history.profiles.find((p) => p.profileId === a)!;

  it('history: items dropped at the 1000 cap on a short last page still mark it truncated', async () => {
    const { s, a } = await setup();
    await servePlayed(a, 1100); // the page at 960 is short (140) but only 40 of it fit
    const doc = (await get(s)).json();
    const own = ownHistory(doc, a);
    expect(own.items).toHaveLength(1000);
    expect(own.truncated).toBe(true);
    expect(doc.history.truncated).toBe(true);
  });

  it('history: exactly 1000 items ending on a short page are complete, not truncated', async () => {
    const { s, a } = await setup();
    const starts = await servePlayed(a, 1000);
    const doc = (await get(s)).json();
    const own = ownHistory(doc, a);
    expect(starts).toEqual([0, 160, 360, 560, 760, 960]); // the last page (960) is short: 40 items, nothing more on the server
    expect(own.items).toHaveLength(1000);
    expect(own.truncated).toBeUndefined();
    expect(doc.history.truncated).toBeUndefined();
  });

  it('history: a failing later page keeps the pages fetched before it, marked partial', async () => {
    const { s, a, aKid } = await setup();
    await servePlayed(a, 1500, 560);
    const doc = (await get(s)).json();
    const own = ownHistory(doc, a);
    expect(own.items).toHaveLength(560); // pages 0, 160 and 360 cover p0..p559
    expect(own.error).toBe('partial');
    expect(doc.history.error).toBeUndefined();
    expect(ownHistory(doc, aKid).items).toHaveLength(1);
  });

  it('a short history is not truncated; one failing profile is marked, the others export', async () => {
    const { s, a, aKid } = await setup();
    env.ctx.jf.history = async (u) => {
      if (u.jellyfin_user_id.startsWith('jfakid')) throw new Error('profile user gone');
      return [item('x1', 'X1')];
    };
    const doc = (await get(s)).json();
    expect(doc.history.truncated).toBeUndefined();
    expect(doc.history.profiles).toEqual([
      { profileId: a, items: [expect.objectContaining({ itemId: 'x1' })] },
      { profileId: aKid, error: 'unavailable' },
    ]);
  });

  it('history failure still yields valid JSON with history.error', async () => {
    const { s } = await setup();
    fakeHistory(true);
    const r = await get(s);
    expect(r.statusCode).toBe(200);
    const doc = JSON.parse(r.body);
    expect(doc.history.error).toBe('unavailable');
    expect(doc.history.profiles).toBeUndefined();
    expect(doc.notifications.items.length).toBeGreaterThan(0); // the rest still exports
    expect(doc.devices.length).toBeGreaterThan(0);
  });

  it('response is streamed with attachment headers and parses as JSON', async () => {
    const { s } = await setup();
    fakeHistory();
    const r = await get(s);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    const day = new Date().toISOString().slice(0, 10);
    expect(r.headers['content-disposition']).toBe(`attachment; filename="friendflix-data-${day}.json"`);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['transfer-encoding']).toBe('chunked'); // a stream, no content-length
    expect(r.headers['content-length']).toBeUndefined();
    expect(() => JSON.parse(r.body)).not.toThrow();
  });

  it('export is audited', async () => {
    const { s, a } = await setup();
    fakeHistory();
    await get(s);
    const rows = (await env.pool.query("select actor, target, meta from audit_log where action='account.export'")).rows;
    expect(rows).toEqual([{ actor: a, target: a, meta: {} }]);
  });

  it('only the newest 100 requests are asked for their state; older ones read unknown', async () => {
    const { s, a } = await setup();
    fakeHistory();
    // 105 more requests, all older than the seeded one
    await env.pool.query(
      `insert into seerr_requests(seerr_request_id, user_id, media_type, tmdb_id, title, created_at)
         select 1000 + n, $1, 'movie', 5000 + n, 'old ' || n, now() - (n || ' days')::interval from generate_series(1, 105) n`, [a]);
    env.seerrCalls.length = 0;
    const doc = (await get(s)).json();
    expect(doc.requests).toHaveLength(106);
    expect(env.seerrCalls.filter((c) => c.path.startsWith('/api/v1/request/'))).toHaveLength(100);
    expect(doc.requests.slice(0, 100).every((r: { status: string }) => r.status === 'available')).toBe(true);
    expect(doc.requests.slice(100).map((r: { status: string; tmdbId: number }) => [r.status, r.tmdbId])).toEqual(
      [100, 101, 102, 103, 104, 105].map((n) => ['unknown', 5000 + n]));
  });

  it('without a request service the requests are listed with state unknown, nothing is asked', async () => {
    const { s } = await setup();
    fakeHistory();
    await env.ctx.settings.save({ REQUESTS_URL: null }, null);
    try {
      env.seerrCalls.length = 0;
      const doc = (await get(s)).json();
      expect(doc.requests.length).toBeGreaterThan(0);
      expect(doc.requests.every((r: { status: string }) => r.status === 'unknown')).toBe(true);
      expect(env.seerrCalls).toEqual([]);
    } finally {
      await env.ctx.settings.save({ REQUESTS_URL: cfg.REQUESTS_URL }, null);
    }
  });

  it('a HEAD request neither runs the export nor audits', async () => {
    const { s } = await setup();
    const asked = fakeHistory();
    const r = await env.app.inject({ method: 'HEAD', url: '/api/account/export', cookies: s.cookies });
    expect(r.statusCode).toBe(404);
    expect(asked).toEqual([]);
    expect((await env.pool.query("select 1 from audit_log where action='account.export'")).rowCount).toBe(0);
  });

  it('a database error mid-stream aborts the download, is logged, and the server keeps serving', async () => {
    const { s } = await setup();
    fakeHistory();
    const db = env.ctx.db;
    env.ctx.db = { query: ((sql: string, p?: unknown[]) => (sql.startsWith('select label, approved, created_at, last_seen from devices')
      ? new Promise((_, rej) => setTimeout(() => rej(new Error('db gone')), 50)) : db.query(sql, p))) as typeof db.query };
    const r = await env.app.inject({ method: 'GET', url: '/api/account/export', cookies: s.cookies }).catch((e: Error) => e);
    // before the first bytes reached the socket Fastify still answers 500; after that the transfer is cut off. Never a
    // silently complete file.
    if (!(r instanceof Error)) {
      if (r.statusCode === 500) expect(r.json()).toEqual({ error: 'internal' });
      else expect(() => JSON.parse(r.body)).toThrow();
    }
    expect((await listErrors(env.ctx, { source: 'server' })).entries.map((e) => e.code)).toContain('GET /api/account/export stream');
    env.ctx.db = db;
    expect((await env.app.inject({ url: '/api/account', cookies: s.cookies })).statusCode).toBe(200);
  });

  it('needs the owner profile and is limited to 5 per hour', async () => {
    const { s, aKid } = await setup();
    fakeHistory();
    const sid = s.cookies.ff_sid!;
    const raw = JSON.parse((await env.kv.get(`sess:${sid}`))!);
    await env.kv.set(`sess:${sid}`, JSON.stringify({ ...raw, profileId: aKid }), 600);
    expect((await get(s)).statusCode).toBe(403);
    await env.kv.set(`sess:${sid}`, JSON.stringify(raw), 600);
    for (let i = 0; i < 5; i++) expect((await get(s)).statusCode).toBe(200);
    expect((await get(s)).statusCode).toBe(429);
  });
});
