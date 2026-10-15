// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pickEncoding } from '../src/compress.js';
import { JellyfinClient } from '../src/jellyfin/client.js';
import { toItemDto } from '../src/jellyfin/dto.js';
import { ITEM_MEMO_MAX, JellyfinService } from '../src/jellyfin/service.js';
import { MemoryKV } from '../src/kv.js';
import { itemsByIds, libraryBecause } from '../src/routes/discover.js';
import { forgetAuth } from '../src/routes/internal.js';
import { requireUser } from '../src/session.js';
import type { Ctx } from '../src/ctx.js';
import type { JfUser } from '../src/types.js';
import { isSetupComplete } from '../src/setup/state.js';
import { cfg, ENC_KEY, fakeHttp, makeEnv, type Call, type Handler, type TestEnv } from './helpers.js';
import { encrypt, keyFromBase64 } from '../src/crypto.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const [A, B, C, D, E] = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(32)) as [string, string, string, string, string];
const encKey = keyFromBase64(ENC_KEY);
const jfUser = (id: string, jf: string): JfUser => ({ id, jellyfin_user_id: jf, jellyfin_username: id, jellyfin_pw_enc: encrypt(encKey, 'pw') });

// ---------------------------------------------------------------------------------------------------------------------------
describe('JellyfinService.item() memo', () => {
  let calls: Call[];
  let state: Record<string, { played: boolean; fail?: number }>;
  let svc: JellyfinService;
  const U1 = jfUser('u1', '1'.repeat(32));
  const U2 = jfUser('u2', '2'.repeat(32));
  beforeEach(() => {
    calls = [];
    state = { [A]: { played: false }, [B]: { played: false } };
    const item: Handler = (u) => {
      const id = u.pathname.split('/')[2]!;
      const st = state[id];
      if (!st) return { status: 404 };
      if (st.fail) { st.fail--; return { status: 500 }; }
      return { json: { Id: id, Name: `N-${u.searchParams.get('userId')?.slice(0, 1)}`, Type: 'Movie', Genres: ['Drama'], UserData: { Played: st.played } } };
    };
    const routes: Record<string, Handler> = {
      'POST /Users/AuthenticateByName': (_u, _i, b) => ({ json: { AccessToken: `tok-${b.Username}`, User: { Id: 'x', Name: b.Username } } }),
      'GET /Items/[0-9a-f]{32}': item,
      'POST /UserPlayedItems/[0-9a-f]{32}': (u) => { state[u.pathname.split('/')[2]!]!.played = true; return { status: 204 }; },
      'POST /UserFavoriteItems/[0-9a-f]{32}': () => ({ status: 204 }),
      'POST /Sessions/Playing/Progress': () => ({ status: 204 }),
    };
    svc = new JellyfinService(new JellyfinClient('http://jf', 'k', fakeHttp(routes, calls)), new MemoryKV(), encKey);
  });
  const itemCalls = () => calls.filter((c) => c.method === 'GET' && c.path.startsWith('/Items/')).length;

  it('collapses concurrent and repeated reads into one Jellyfin call', async () => {
    const r = await Promise.all(Array.from({ length: 8 }, () => svc.item(U1, A)));
    expect(r.every((i) => i.id === A)).toBe(true);
    await svc.item(U1, A);
    expect(itemCalls()).toBe(1);
  });

  it('hands out copies: a caller mutating its result never changes the memo', async () => {
    const x = await svc.item(U1, A);
    x.name = 'changed';
    x.genres.push('Horror');
    const y = await svc.item(U1, A);
    expect(y.name).toBe('N-1');
    expect(y.genres).toEqual(['Drama']);
  });

  it('never serves one user the entry of another (same item)', async () => {
    const a = await svc.item(U1, A);
    const b = await svc.item(U2, A);
    expect(a.name).toBe('N-1');
    expect(b.name).toBe('N-2');
    expect(itemCalls()).toBe(2);
    // same Jellyfin user but another portal profile id: separate entry as well
    await svc.item({ ...U1, id: 'other-profile' }, A);
    expect(itemCalls()).toBe(3);
  });

  it('setPlayed / setFavorite / progress reports invalidate that user (and only that user)', async () => {
    expect((await svc.item(U1, A)).played).toBe(false);
    await svc.item(U2, A);
    await svc.setPlayed(U1, A, true);
    expect((await svc.item(U1, A)).played).toBe(true); // fresh
    const n = itemCalls();
    await svc.item(U2, A); // U2's entry survived
    expect(itemCalls()).toBe(n);
    await svc.setFavorite(U1, B, true);
    await svc.item(U1, A);
    expect(itemCalls()).toBe(n + 1);
    await svc.report(U1, { event: 'progress', itemId: A, mediaSourceId: 'ms', playSessionId: 'ps', positionTicks: 0, paused: false });
    await svc.item(U1, A);
    expect(itemCalls()).toBe(n + 2);
  });

  it('a read racing a write does not survive the write', async () => {
    const slowWrite = svc.setPlayed(U1, A, true);
    const during = svc.item(U1, A); // may see the old state
    await Promise.all([slowWrite, during]);
    expect((await svc.item(U1, A)).played).toBe(true);
  });

  it('failures are not cached', async () => {
    state[A]!.fail = 1;
    await expect(svc.item(U1, A)).rejects.toThrow();
    expect((await svc.item(U1, A)).id).toBe(A);
    await expect(svc.item(U1, C)).rejects.toMatchObject({ status: 404 });
    state[C] = { played: false };
    expect((await svc.item(U1, C)).id).toBe(C);
  });

  it('expires after the TTL', async () => {
    const real = Date.now;
    try {
      await svc.item(U1, A);
      const t = real();
      Date.now = () => t + 11_000;
      await svc.item(U1, A);
      expect(itemCalls()).toBe(2);
    } finally {
      Date.now = real;
    }
  });

  it('is bounded (LRU)', async () => {
    for (let n = 0; n < ITEM_MEMO_MAX + 5; n++) {
      const id = n.toString(16).padStart(32, '0');
      state[id] = { played: false };
      await svc.item(U1, id);
    }
    expect((svc as unknown as { itemMemo: Map<string, unknown> }).itemMemo.size).toBe(ITEM_MEMO_MAX);
    const before = itemCalls();
    await svc.item(U1, '0'.repeat(32)); // oldest one was evicted
    expect(itemCalls()).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('itemsByIds', () => {
  it('fetches chunks of 40 at most 4 at a time and keeps the requested order', async () => {
    let active = 0;
    let peak = 0;
    const ids = Array.from({ length: 300 }, (_, n) => (n + 1).toString(16).padStart(32, '0')).reverse();
    const ctx = {
      jf: {
        items: async (_u: JfUser, q: { ids: string[] }) => {
          active++;
          peak = Math.max(peak, active);
          await sleep(10);
          active--;
          return { items: q.ids.filter((i) => i !== ids[5]).map((id) => ({ id })), total: 0 }; // one invisible id
        },
      },
    } as unknown as Ctx;
    const t = performance.now();
    const out = await itemsByIds(ctx, jfUser('u', 'j'), ids);
    expect(peak).toBe(4);
    expect(performance.now() - t).toBeLessThan(8 * 10 * 0.9); // 8 chunks sequentially would take >= 80 ms
    expect(out.map((i) => i.id)).toEqual(ids.filter((i) => i !== ids[5]));
  });

  it('strict mode throws on a Jellyfin error, lenient mode drops the chunk', async () => {
    const ctx = { jf: { items: async () => { throw new Error('jf down'); } } } as unknown as Ctx;
    await expect(itemsByIds(ctx, jfUser('u', 'j'), [A], true)).rejects.toThrow('jf down');
    expect(await itemsByIds(ctx, jfUser('u', 'j'), [A])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('image tags in ItemDto', () => {
  it('maps Jellyfin image tags and keeps the booleans', () => {
    const d = toItemDto({ Id: A, Name: 'x', Type: 'Episode', ImageTags: { Primary: 'p1', Logo: 'l1', Thumb: 't1' }, BackdropImageTags: ['b1', 'b2'], SeriesPrimaryImageTag: 's1' });
    expect(d.imageTags).toEqual({ primary: 'p1', backdrop: 'b1', logo: 'l1', thumb: 't1', seriesPrimary: 's1' });
    expect([d.image, d.backdrop, d.logo]).toEqual([true, true, true]);
  });
  it('omits the field without images and drops malformed tags', () => {
    expect(toItemDto({ Id: A, Name: 'x', Type: 'Movie' }).imageTags).toBeUndefined();
    expect(toItemDto({ Id: A, Name: 'x', Type: 'Movie', ImageTags: { Primary: 'a b&c' } }).imageTags).toBeUndefined();
  });
});

describe('pickEncoding', () => {
  it('prefers brotli, honours q=0 and wildcards', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br');
    expect(pickEncoding('gzip')).toBe('gzip');
    expect(pickEncoding('br;q=0, gzip;q=0.5')).toBe('gzip');
    expect(pickEncoding('*')).toBe('gzip');
    expect(pickEncoding('identity')).toBeNull();
    expect(pickEncoding(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('HTTP: compression, Server-Timing, media authz single flight, "because" cache', () => {
  let env: TestEnv;
  let s: { cookies: Record<string, string>; csrf: string };
  const SIMILAR = [B, C, D, E];
  const big = Array.from({ length: 200 }, (_, n) => ({ n, text: 'FriendFlix '.repeat(4) }));
  beforeAll(async () => {
    env = await makeEnv({
      'GET /Items/[0-9a-f]{32}': (u) => ({ json: { Id: u.pathname.split('/')[2], Name: `Item ${u.pathname.split('/')[2]!.slice(0, 1)}`, Type: 'Movie', UserData: {} } }),
      'GET /Items': (u) => (u.searchParams.get('filters') === 'IsPlayed' ? { json: { Items: [{ Id: A, Name: 'Item a', Type: 'Movie', UserData: { Played: true } }] } } : { json: { Items: [] } }),
      'GET /Items/[0-9a-f]{32}/Similar': () => ({ json: { Items: SIMILAR.map((id) => ({ Id: id, Name: `Item ${id.slice(0, 1)}`, Type: 'Movie', UserData: {} })) } }),
      'POST /UserPlayedItems/[0-9a-f]{32}': () => ({ status: 204 }),
    }, {
      register: [(app, ctx) => {
        app.get('/test/big', async () => ({ items: big }));
        app.get('/test/small', async () => ({ ok: true }));
        app.get('/test/text', async (_req, reply) => reply.type('text/plain').send('x'.repeat(5000)));
        app.get('/test/db', async () => {
          await ctx.db.query('select 1');
          await ctx.db.query('select 2');
          await ctx.kv.get('nothing');
          return { ok: true };
        });
        app.get('/test/because', { preHandler: requireUser(ctx) }, async (req) => libraryBecause(ctx, req.jfUser!, req.profile!.id));
      }],
    });
    s = await env.login();
  });
  afterAll(() => env.close());
  const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf, ...headers }, payload: body as object });

  it('compresses large JSON with brotli or gzip and sets Vary', async () => {
    const plain = await call('GET', '/test/big');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.headers.vary).toContain('Accept-Encoding');
    const br = await call('GET', '/test/big', undefined, { 'accept-encoding': 'gzip, deflate, br' });
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers.vary).toContain('Accept-Encoding');
    expect(JSON.parse(brotliDecompressSync(br.rawPayload).toString())).toEqual({ items: big });
    expect(br.rawPayload.length).toBeLessThan(plain.rawPayload.length / 4);
    const gz = await call('GET', '/test/big', undefined, { 'accept-encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(Number(gz.headers['content-length'])).toBe(gz.rawPayload.length);
    expect(JSON.parse(gunzipSync(gz.rawPayload).toString())).toEqual({ items: big });
  });

  it('leaves small JSON, non-JSON bodies and HEAD alone', async () => {
    expect((await call('GET', '/test/small', undefined, { 'accept-encoding': 'br' })).headers['content-encoding']).toBeUndefined();
    expect((await call('GET', '/test/text', undefined, { 'accept-encoding': 'br' })).headers['content-encoding']).toBeUndefined();
    expect((await call('HEAD', '/test/big', undefined, { 'accept-encoding': 'br' })).headers['content-encoding']).toBeUndefined();
  });

  it('can be switched off (API_COMPRESSION=false)', async () => {
    env.ctx.cfg = { ...cfg, API_COMPRESSION: 'false' };
    try {
      expect((await call('GET', '/test/big', undefined, { 'accept-encoding': 'br' })).headers['content-encoding']).toBeUndefined();
    } finally {
      env.ctx.cfg = cfg;
    }
  });

  it('a saved API_COMPRESSION applies to the next response (live, no restart)', async () => {
    try {
      await env.ctx.settings.save({ API_COMPRESSION: false }, null);
      expect((await call('GET', '/test/big', undefined, { 'accept-encoding': 'br' })).headers['content-encoding']).toBeUndefined();
      expect(env.ctx.settings.pendingRestart()).not.toContain('API_COMPRESSION');
      await env.ctx.settings.save({ API_COMPRESSION: true }, null);
      expect((await call('GET', '/test/big', undefined, { 'accept-encoding': 'br' })).headers['content-encoding']).toBe('br');
    } finally {
      await env.ctx.settings.save({ API_COMPRESSION: null }, null);
    }
  });

  it('emits Server-Timing with db / kv / jf breakdown', async () => {
    const h = (await env.app.inject('/health')).headers['server-timing'];
    expect(h).toMatch(/^app;dur=[\d.]+$/);
    await isSetupComplete(env.ctx); // the test above moved the settings rev: the setup gate re-reads its state once (one db call)
    const d = String((await call('GET', '/test/db')).headers['server-timing']);
    expect(d).toMatch(/db;dur=[\d.]+;desc="2 calls"/);
    expect(d).toMatch(/kv;dur=[\d.]+;desc="\d+ calls?"/); // session lookup + the explicit get
    expect(d).toMatch(/app;dur=[\d.]+$/);
    await call('GET', `/api/items/${E}/similar`); // first Jellyfin call of the user also logs in (token)
    const j = String((await call('GET', `/api/items/${E}/similar`)).headers['server-timing']);
    expect(j).toMatch(/jf;dur=[\d.]+;desc="1 call"/);
    // POST with a body: the store survives body parsing
    const p = String((await call('POST', `/api/items/${E}/played`, {})).headers['server-timing']);
    expect(p).toMatch(/jf;dur=[\d.]+;desc="\d+ calls?"/);
  });

  it('/internal/authz: concurrent lookups of one session share one session load; failures are not memoised', async () => {
    const sid = s.cookies.ff_sid!;
    const authz = () => env.app.inject({ method: 'POST', url: '/internal/authz', headers: { 'x-internal-secret': cfg.INTERNAL_SECRET }, payload: { sid } });
    const realGet = env.kv.get.bind(env.kv);
    let loads = 0;
    let fail = false;
    env.kv.get = async (k: string) => {
      if (k === `sess:${sid}`) {
        loads++;
        await sleep(20);
        if (fail) throw new Error('redis down');
      }
      return realGet(k);
    };
    try {
      forgetAuth(sid);
      const rs = await Promise.all(Array.from({ length: 30 }, authz));
      expect(rs.every((r) => r.statusCode === 200 && r.json().token)).toBe(true);
      expect(loads).toBe(1);
      forgetAuth(sid);
      fail = true;
      const bad = await Promise.all(Array.from({ length: 5 }, authz));
      expect(bad.every((r) => r.statusCode === 500)).toBe(true);
      expect(loads).toBe(2);
      fail = false;
      expect((await authz()).statusCode).toBe(200); // not memoised: retried
      expect(loads).toBe(3);
    } finally {
      env.kv.get = realGet;
    }
  });

  it('"because": cached per Jellyfin user + profile; new thumbs and plays take effect at once', async () => {
    const jf = () => env.jfCalls.filter((c) => c.path.endsWith('/Similar')).length;
    const n0 = jf();
    const first = (await call('GET', '/test/because')).json();
    expect(first.because).toMatchObject({ id: A, liked: false }); // seeded by the last played title
    expect(first.items.map((i: any) => i.id)).toEqual(SIMILAR);
    await call('GET', '/test/because');
    expect(jf()).toBe(n0 + 1); // second request: cache hit

    await call('PUT', `/api/items/${E}/thumb`, { value: -1 }); // thumbs down: filtered without recomputing
    expect((await call('GET', '/test/because')).json().items.map((i: any) => i.id)).toEqual([B, C, D]);
    expect(jf()).toBe(n0 + 1);

    await call('PUT', `/api/items/${B}/thumb`, { value: 1 }); // thumbs up: new seed
    const reseeded = (await call('GET', '/test/because')).json();
    expect(reseeded.because).toMatchObject({ id: B, liked: true });
    expect(reseeded.items.map((i: any) => i.id)).toEqual([C, D]);
    expect(jf()).toBe(n0 + 2);

    await call('POST', `/api/items/${C}/played`, {}); // a play bumps the user-data version
    await call('GET', '/test/because');
    expect(jf()).toBe(n0 + 3);
  });
});
