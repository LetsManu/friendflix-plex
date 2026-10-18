// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Fork (1.1 cast parity): upstream's cast tests for the stop report and the queued next episode (test/cast.test.ts "cast session: stop
 * report and the queued next episode"), on Plex: the real cast route, cast.ts (predecessor binding, NEXT_OVERLAP_MS, DRAIN_MS) and the
 * PRODUCTION Plex playback wiring with its own stream limit (plex/limits.ts) plus the gateway's real Plex adapter.
 * On Plex max_streams is enforced twice: FriendFlix's live records (routes/cast.ts) and the identity's running Plex transcodes
 * (PlexLimits). The queued episode may overlap exactly its predecessor at both levels, its session is cast-only (gateway), and its
 * token is served only within the overlap window while the predecessor plays: never a stream past max_streams.
 */
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashToken, NEXT_OVERLAP_MS } from '../../src/cast.js';
import { revokeSessions } from '../../src/devices.js';
import { countLive, DRAIN_MS, getLive, setLive } from '../../src/live.js';
import { cfg, makeEnv, type TestEnv } from '../helpers.js';
import { PLEX_TOKEN, PlexFake } from '../plexfake.js';
import { item } from './setup.js';
import { TranscoderFake } from './streamfake.js';

type Sess = { cookies: Record<string, string>; csrf: string };
const GATEWAY_PLEX = join(import.meta.dirname, '../../../gateway/src/upstream/plex.ts');
const skipClock = (ms: number) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + ms); };

describe('Plex: cast stop report and the queued next episode', () => {
  let env: TestEnv;
  let tf: TranscoderFake;
  let gw: any;
  let admin: Sess;
  let uid = '';
  let identity = '';
  const bodies: string[] = [];
  const fake = new PlexFake();
  const show = fake.addShow({ title: 'Cast Show', rating: 'TV-PG', episodeRating: 'TV-PG', episodes: 4 });
  const [E1, E2, E3, E4] = show.episodes.map((e) => item(e)) as [string, string, string, string];
  const role0 = { max: 0 };

  beforeAll(async () => {
    env = await makeEnv({}, { server: 'plex', plexFake: fake, plexFetch: (f) => (tf = new TranscoderFake(f.fetch)).fetch });
    admin = await env.login();
    uid = (await call(admin, 'GET', '/api/me')).json().id;
    identity = (await env.pool.query<{ j: string }>('select jellyfin_user_id j from users where id = $1', [uid])).rows[0]!.j;
    const { createPlexUpstream } = await import(GATEWAY_PLEX);
    gw = createPlexUpstream({ token: () => PLEX_TOKEN, secret: () => cfg.INTERNAL_SECRET });
    role0.max = env.ctx.roles.admin!.maxStreams;
  });
  afterEach(async () => {
    vi.useRealTimers();
    env.ctx.roles.admin!.maxStreams = role0.max;
    await env.pool.query('update plex_media_policies set max_streams = null where identity_id = $1', [identity]);
  });
  afterAll(async () => {
    for (const b of bodies) expect(b).not.toContain(PLEX_TOKEN);
    await env.plex!.ms.stop();
    await env.close();
  });

  let n = 0;
  async function call(s: Sess, method: string, url: string, body?: unknown) {
    const r = await env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf, 'x-forwarded-for': `10.2.${Math.floor(++n / 250)}.${n % 250}` }, payload: body as object });
    bodies.push(r.body);
    return r;
  }
  const authz = (ct: string, client = '198.51.100.1') =>
    env.app.inject({ method: 'POST', url: '/internal/authz', headers: { 'x-internal-secret': cfg.INTERNAL_SECRET }, payload: { ct, client } });
  const create = async (itemId: string, body: Record<string, unknown> = {}) => {
    const r = await call(admin, 'POST', '/api/cast/session', { itemId, ...body });
    const j = r.json();
    return { r, j, ct: (/\/media\/c\/([\w-]{43})\//.exec(j.contentUrl ?? '')?.[1]) as string };
  };
  const report = (kind: 'start' | 'progress' | 'stop', itemId: string, ps: string, mediaSourceId: string) =>
    call(admin, 'POST', `/api/playback/${kind}`, { itemId, playSessionId: ps, mediaSourceId, positionTicks: 0, isPaused: false, playMethod: 'Transcode' });
  const stale = async (ct: string) => env.kv.set(`cast:${hashToken(ct)}`, JSON.stringify({ ...JSON.parse((await env.kv.get(`cast:${hashToken(ct)}`))!), seen: 0 }), 600);
  /** the gateway's Plex adapter for the HLS playlist of a cast answer: on the cast route (token scope) or with a cookie */
  const gateway = (contentUrl: string, cast: boolean) => {
    const path = new URL(contentUrl).pathname.replace(/^\/media\/c\/[\w-]{43}/, '');
    const itemId = /\/Videos\/(9f1e0[0-9a-f]{27})\//.exec(path)![1]!;
    return gw.authorize({ path, query: new URLSearchParams(), cast, checkItem: async (id: string) => id === itemId });
  };
  /** clean slate for this device: no tokens, no live streams, no stop marks, every Plex transcode reaped; maxStreams 1 at both levels */
  const fresh = async () => {
    await revokeSessions(env.ctx, uid);
    admin = await env.login();
    for (const pre of [`play:${uid}:`, `pstop:${uid}:`, `povl:${uid}:`, 'plexstarted:', 'plexplay:', 'plexnext:']) for (const k of await env.kv.keys(pre)) await env.kv.del(k);
    for (const s of tf.sessions.values()) s.stopped = true;
    env.ctx.roles.admin!.maxStreams = 1;
    await env.pool.query('update plex_media_policies set max_streams = 1 where identity_id = $1', [identity]);
  };
  /** the playing cast (reported `start`), then its queued next episode's token */
  const playingThenNext = async () => {
    const cur = await create(E1);
    expect(cur.r.statusCode, cur.r.body).toBe(200);
    await report('start', E1, cur.j.playSessionId, cur.j.mediaSourceId);
    const nx = await create(E2, { next: true, after: cur.j.castId });
    return { cur, nx };
  };
  const progress = (cur: { j: { playSessionId: string; mediaSourceId: string } }) => report('progress', E1, cur.j.playSessionId, cur.j.mediaSourceId);

  it('next: no predecessor (no cast token of this device) is 429', async () => {
    await fresh();
    env.ctx.roles.admin!.maxStreams = 5;
    expect((await call(admin, 'POST', '/api/cast/session', { itemId: E2, next: true })).statusCode).toBe(429);
  });

  it('next: issued while the playing cast fills the limit; a wrong predecessor is refused; never beyond the limit', async () => {
    await fresh();
    const { cur, nx } = await playingThenNext();
    expect(nx.r.statusCode, nx.r.body).toBe(200);
    expect(tf.sessions.get(nx.j.playSessionId)?.stopped).toBe(false); // the receiver can preload it
    expect(tf.sessions.get(cur.j.playSessionId)?.stopped).toBe(false);
    expect((await call(admin, 'POST', '/api/cast/session', { itemId: E3 })).statusCode).toBe(429);
    expect((await call(admin, 'POST', '/api/cast/session', { itemId: E2, next: true, after: 'f'.repeat(32) })).statusCode).toBe(409);
    // the browser player: both Plex transcodes count
    expect((await call(admin, 'POST', '/api/playback/info', { itemId: E3 })).statusCode).toBe(429);
    await setLive(env.ctx, { userId: uid, userName: 'a', itemId: E4, title: 't', positionTicks: 0, isPaused: false, playSessionId: 'other-ps-2', updatedAt: Date.now(), source: 'portal' });
    expect((await call(admin, 'POST', '/api/cast/session', { itemId: E3, next: true, after: cur.j.castId })).statusCode).toBe(429);
  });

  it('the Plex stream limit alone (no FriendFlix live record): a second title is refused, the queued episode after the running cast is not', async () => {
    await fresh();
    const cur = await create(E1); // the transcode runs at Plex, nothing reported yet
    expect(cur.r.statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(0);
    const other = await call(admin, 'POST', '/api/cast/session', { itemId: E3 });
    expect(other.statusCode).toBe(429);
    expect(other.json()).toEqual({ error: 'max_streams' });
    const nx = await create(E2, { next: true, after: cur.j.castId });
    expect(nx.r.statusCode, nx.r.body).toBe(200);
    // the exemption is bound to the predecessor: a non-cast playback naming nothing gets none
    expect((await call(admin, 'POST', '/api/playback/info', { itemId: E4 })).statusCode).toBe(429);
  });

  it('the queued episode\'s session is cast-only: the gateway refuses it with a cookie, a normal cast session works both ways', async () => {
    await fresh();
    const { cur, nx } = await playingThenNext();
    expect(await gateway(nx.j.contentUrl, true)).toBe(true);
    expect(await gateway(nx.j.contentUrl, false)).toBe(false);
    expect(await gateway(cur.j.contentUrl, true)).toBe(true);
    expect(await gateway(cur.j.contentUrl, false)).toBe(true);
    // its token is still bound to its item: the predecessor's session with the queued token's scope fails the item check
    const curPath = new URL(cur.j.contentUrl).pathname.replace(/^\/media\/c\/[\w-]{43}/, '');
    expect(await gw.authorize({ path: curPath, query: new URLSearchParams(), cast: true, checkItem: async (id: string) => id === E2 })).toBe(false);
  });

  it('next: repeated requests keep one queued token and one queued Plex transcode (the older one ends), the playing one stays', async () => {
    await fresh();
    const { cur, nx } = await playingThenNext();
    const nx2 = await create(E2, { next: true, after: cur.j.castId });
    expect(nx2.r.statusCode, nx2.r.body).toBe(200);
    expect((await authz(nx.ct)).statusCode).toBe(401);
    expect((await authz(cur.ct)).statusCode).toBe(200);
    expect((await authz(nx2.ct)).statusCode).toBe(200);
    expect(tf.sessions.get(nx.j.playSessionId)?.stopped).toBe(true);
    expect(tf.sessions.get(nx2.j.playSessionId)?.stopped).toBe(false);
    expect(tf.sessions.get(cur.j.playSessionId)?.stopped).toBe(false);
    // another episode as the queued one (the viewer picked a different next): it replaces it the same way
    const nx3 = await create(E3, { next: true, after: cur.j.castId });
    expect(nx3.r.statusCode, nx3.r.body).toBe(200);
    expect(tf.sessions.get(nx2.j.playSessionId)?.stopped).toBe(true);
    expect((await env.kv.keys('plexnext:')).length).toBe(1);
  });

  it('next: the preload overlap is served and counted once (the playing stream); after its stop the next one counts', async () => {
    await fresh();
    const { cur, nx } = await playingThenNext();
    expect((await authz(nx.ct)).statusCode).toBe(200);
    await stale(nx.ct);
    skipClock(5100);
    expect((await authz(nx.ct)).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(1);
    expect(await getLive(env.ctx, uid, nx.j.playSessionId)).toBeNull();
    await report('stop', E1, cur.j.playSessionId, cur.j.mediaSourceId);
    expect(tf.sessions.get(cur.j.playSessionId)?.stopped).toBe(true); // the stop report ends the Plex transcode
    // the queued episode's Plex transcode counts from its start on: with the predecessor over, another title stays refused
    expect((await call(admin, 'POST', '/api/playback/info', { itemId: E4 })).statusCode).toBe(429);
    skipClock(400_000); // long past the overlap window: the predecessor is over, the token behaves normally
    await stale(nx.ct);
    expect((await authz(nx.ct)).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(1);
    expect(await getLive(env.ctx, uid, nx.j.playSessionId)).not.toBeNull();
  });

  it('next: once it plays it is the predecessor of the following one and is not replaced', async () => {
    await fresh();
    const { cur, nx } = await playingThenNext();
    await report('stop', E1, cur.j.playSessionId, cur.j.mediaSourceId);
    await report('start', E2, nx.j.playSessionId, nx.j.mediaSourceId);
    expect((await call(admin, 'POST', '/api/cast/session', { itemId: E3, next: true, after: cur.j.castId })).statusCode).toBe(409);
    const nx2 = await create(E3, { next: true, after: nx.j.castId });
    expect(nx2.r.statusCode, nx2.r.body).toBe(200);
    expect((await authz(nx.ct)).statusCode).toBe(200);
    expect(tf.sessions.get(nx.j.playSessionId)?.stopped).toBe(false);
    await report('stop', E2, nx.j.playSessionId, nx.j.mediaSourceId);
  });

  it('next: re-minting does not renew the overlap: the window belongs to the play session it follows', async () => {
    await fresh();
    const { cur, nx } = await playingThenNext();
    const elsewhere = '203.0.113.78';
    expect((await authz(nx.ct, elsewhere)).statusCode).toBe(200);
    skipClock(170_000);
    await progress(cur);
    const nx2 = await create(E2, { next: true, after: cur.j.castId });
    expect(nx2.r.statusCode, nx2.r.body).toBe(200);
    expect((await authz(nx2.ct, elsewhere)).statusCode).toBe(200);
    skipClock(11_000); // 181 s after the first overlap fetch
    await progress(cur);
    expect((await authz(nx2.ct, elsewhere)).statusCode).toBe(401);
    expect(await countLive(env.ctx, uid)).toBe(1);
  });

  it('a stop report only excuses a short drain: fetches of the stopped token count again after DRAIN_MS', async () => {
    await fresh();
    const { ct, j } = await create(E1);
    await report('start', E1, j.playSessionId, j.mediaSourceId);
    await report('stop', E1, j.playSessionId, j.mediaSourceId);
    skipClock(60_000);
    await stale(ct);
    expect((await authz(ct)).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(0);
    skipClock(70_000); // 130 s after the stop
    await stale(ct);
    expect((await authz(ct)).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(1);
    expect(DRAIN_MS).toBe(120_000);
  });

  it('next: used concurrently while the predecessor plays: refused once the 180 s overlap is over, never counted twice', async () => {
    await fresh();
    const { cur, nx } = await playingThenNext();
    const elsewhere = '203.0.113.77';
    expect((await authz(nx.ct, elsewhere)).statusCode).toBe(200);
    skipClock(NEXT_OVERLAP_MS - 10_000);
    await progress(cur);
    expect((await authz(nx.ct, elsewhere)).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(1);
    skipClock(20_000);
    await progress(cur);
    expect((await authz(nx.ct, elsewhere)).statusCode).toBe(401);
    expect(await countLive(env.ctx, uid)).toBe(1);
    expect(await getLive(env.ctx, uid, nx.j.playSessionId)).toBeNull();
    // and the cookie path never was a way around the window
    expect(await gateway(nx.j.contentUrl, false)).toBe(false);
    expect(NEXT_OVERLAP_MS).toBe(180_000);
  });

  it('a revoked token whose stream never reported `start` frees its slot; the cast answers never carry the Plex token', async () => {
    await fresh();
    const { ct, j } = await create(E1);
    await stale(ct);
    skipClock(5100);
    expect((await authz(ct)).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(1);
    expect((await call(admin, 'DELETE', `/api/cast/session/${j.castId}`)).statusCode).toBe(200);
    expect(await countLive(env.ctx, uid)).toBe(0);
    for (const u of [j.contentUrl, j.imageUrl ?? '']) {
      expect(u).not.toContain(PLEX_TOKEN);
      expect(u).not.toMatch(/plex\.test|x-plex|\/library\//i);
    }
  });
});
