import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../src/crypto.js';
import { MediaError } from '../src/media/types.js';
import type { JfUser } from '../src/types.js';
import { ENC_KEY, makeEnv, type TestEnv } from './helpers.js';

/** Block 21 T3: seam methods itemAbout / itemCollections (Jellyfin). */
const id = (c: string) => c.repeat(32);
const MOV = id('a'), HID = id('d'), B1 = id('1'), B2 = id('2'), LONE = id('9');
const P1 = id('b'), P2 = id('c'), P3 = id('e'), P4 = id('f');
const KID = id('5'), ADULT = id('6');
const jfUser = (uid: string, name: string): JfUser => ({ id: name, jellyfin_user_id: uid, jellyfin_username: name, jellyfin_pw_enc: encrypt(Buffer.from(ENC_KEY, 'base64'), 'pw') });
const adult = jfUser(ADULT, 'adult'), kid = jfUser(KID, 'kid');

const raw: Record<string, Record<string, unknown>> = {
  [MOV]: {
    Id: MOV, Name: 'Ashfall', Type: 'Movie', Taglines: ['In space...', 'x'], OriginalTitle: 'Ashfall (orig)', PremiereDate: '1979-05-25T00:00:00Z',
    ProductionLocations: ['USA', 'UK'], Studios: [{ Name: 'S1' }, { Name: 'S2' }, { Name: 'S3' }, { Name: 'S4' }, { Name: 'S5' }, { Name: 'S6' }, { Name: 'S7' }],
    Tags: Array.from({ length: 25 }, (_, i) => `t${i}`), ProviderIds: { imdb: 'tt0078748', Tmdb: '348', TVDB: '77' }, CommunityRating: 8.4, CriticRating: 93,
  },
  [P1]: { Id: P1, Name: 'Zwei', Type: 'Movie', PremiereDate: '1986-07-18T00:00:00Z', ProductionYear: 1986, ProviderIds: { Tmdb: '679' } },
  [P2]: { Id: P2, Name: 'Eins', Type: 'Movie', PremiereDate: '1979-05-25T00:00:00Z', ProductionYear: 1979, ProviderIds: { tmdb: '348' } },
  [P3]: { Id: P3, Name: 'Drei', Type: 'Movie', PremiereDate: '1992-05-22T00:00:00Z', ProductionYear: 1992 },
  [P4]: { Id: P4, Name: 'Vier', Type: 'Movie', PremiereDate: '1997-11-26T00:00:00Z', ProductionYear: 1997, ProviderIds: { Tmdb: '8077' } },
  [B1]: { Id: B1, Name: 'Ashfall Collection', Type: 'BoxSet' },
  [B2]: { Id: B2, Name: 'Other Collection', Type: 'BoxSet' },
};
const members: Record<string, string[]> = { [B1]: [P1, P2, P3, MOV], [B2]: [P4] };
const failingSets = new Set<string>();
const hiddenFor: Record<string, Set<string>> = { [KID]: new Set([P3]), [ADULT]: new Set(), };
const hiddenBoxFor: Record<string, Set<string>> = { [KID]: new Set(), [ADULT]: new Set() };
let adminBoxsetPages = 0, adminChildCalls = 0;

let env: TestEnv;
beforeAll(async () => {
  env = await makeEnv({
    'GET /Items': (u) => {
      const uid = u.searchParams.get('userId');
      const ids = (u.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      const parent = u.searchParams.get('parentId');
      if (!uid) { // admin key
        if (u.searchParams.get('includeItemTypes') === 'BoxSet') { adminBoxsetPages++; return { json: { Items: Object.keys(members).map((b) => ({ Id: b })) } }; }
        if (parent) { adminChildCalls++; if (failingSets.has(parent)) return { status: 500 }; return { json: { Items: (members[parent] ?? []).map((c) => ({ Id: c })) } }; }
        return { json: { Items: [] } };
      }
      const hid = hiddenFor[uid] ?? new Set();
      if (ids.length) return { json: { Items: ids.filter((i) => raw[i] && !hid.has(i) && !hiddenBoxFor[uid]?.has(i)).map((i) => raw[i]) } };
      if (parent) {
        if (hiddenBoxFor[uid]?.has(parent)) return { status: 404 };
        return { json: { Items: (members[parent] ?? []).filter((c) => !hid.has(c) && raw[c]).map((c) => raw[c]) } };
      }
      return { json: { Items: [] } };
    },
  });
});
afterAll(() => env.close());
const jf = () => env.ctx.jf;

describe('itemAbout', () => {
  it('maps tagline, original title, countries, studios, tags, provider ids (Imdb/imdb), community + critic rating', async () => {
    const a = await jf().itemAbout!(adult, MOV);
    expect(a).toMatchObject({ type: 'Movie', tagline: 'In space...', originalTitle: 'Ashfall (orig)', premiereDate: '1979-05-25T00:00:00Z', countries: ['USA', 'UK'], communityRating: 8.4, criticRating: 93 });
    expect(a.providerIds).toEqual({ imdb: 'tt0078748', tmdb: '348', tvdb: '77' });
    expect(a.studios).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
    expect(a.tags).toHaveLength(20);
    const call = env.jfCalls.find((c) => c.path === '/Items' && c.search.includes('ProviderIds%2CTaglines'))!;
    expect(call.search).toContain(`userId=${ADULT}`);
    expect(call.search).toContain('enableImages=false');
  });
  it('itemAbout of an invisible item → 404', async () => {
    const err = await jf().itemAbout!(adult, HID).catch((e) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect(err.status).toBe(404);
  });
});

describe('itemCollections', () => {
  it('two BoxSets, item in one → one collection, parts in premiere order with tmdbId', async () => {
    const c = await jf().itemCollections!(adult, MOV);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ id: B1, name: 'Ashfall Collection' });
    expect(c[0]!.parts.map((p) => p.item.name)).toEqual(['Eins', 'Ashfall', 'Zwei', 'Drei']);
    expect(c[0]!.parts.map((p) => p.tmdbId)).toEqual(['348', '348', '679', undefined]);
  });
  it('parts hidden from the viewer (fewer children for the kids user token) are absent', async () => {
    const c = await jf().itemCollections!(kid, MOV);
    expect(c[0]!.parts.map((p) => p.item.name)).toEqual(['Eins', 'Ashfall', 'Zwei']);
    const calls = env.jfCalls.filter((x) => x.path === '/Items' && x.search.includes(`parentId=${B1}`) && x.search.includes('userId='));
    expect(calls.at(-1)!.search).toContain(`userId=${KID}`);
  });
  it('a BoxSet the viewer cannot see is skipped (name never shown); a non-ok parts answer skips it too', async () => {
    hiddenBoxFor[KID]!.add(B1);
    try { expect(await jf().itemCollections!(kid, MOV)).toEqual([]); } finally { hiddenBoxFor[KID]!.delete(B1); }
  });
  it('item in no BoxSet → []', async () => {
    expect(await jf().itemCollections!(adult, LONE)).toEqual([]);
  });
  it('membership index is built once for two concurrent calls and reused from kv (admin calls counted)', async () => {
    await env.kv.del('jf:boxsets:v1');
    (jf() as unknown as { boxsetIndexBuild: null }).boxsetIndexBuild = null;
    adminBoxsetPages = 0; adminChildCalls = 0;
    await Promise.all([jf().itemCollections!(adult, MOV), jf().itemCollections!(kid, MOV)]);
    expect(adminBoxsetPages).toBe(1);
    expect(adminChildCalls).toBe(2);
    await jf().itemCollections!(adult, MOV);
    expect(adminBoxsetPages).toBe(1);
    expect(await env.kv.get('jf:boxsets:v1')).toBeTruthy();
    // a second service instance (empty memory) reads the kv copy
    (jf() as unknown as { boxsetIndexBuild: null }).boxsetIndexBuild = null;
    await jf().itemCollections!(adult, MOV);
    expect(adminBoxsetPages).toBe(1);
  });

  it('final review I1: the index is built with at most 8 box-set calls at a time, in parallel', async () => {
    const extra = Array.from({ length: 20 }, (_, i) => 'ee' + String(i).padStart(30, '0'));
    for (const b of extra) members[b] = [];
    const client = (jf() as unknown as { client: { adminJson: (p: string) => Promise<unknown> } }).client;
    const orig = client.adminJson.bind(client);
    let inflight = 0, max = 0;
    const spy = vi.spyOn(client, 'adminJson').mockImplementation(async (p: string) => {
      if (!p.includes('parentId=')) return orig(p);
      inflight++; max = Math.max(max, inflight);
      await new Promise((r) => setTimeout(r, 5));
      try { return await orig(p); } finally { inflight--; }
    });
    try {
      await env.kv.del('jf:boxsets:v1');
      (jf() as unknown as { boxsetIndexBuild: null }).boxsetIndexBuild = null;
      expect(await jf().itemCollections!(adult, MOV)).toHaveLength(1);
      expect(max).toBeGreaterThan(1);
      expect(max).toBeLessThanOrEqual(8);
    } finally {
      spy.mockRestore();
      for (const b of extra) delete members[b];
      await env.kv.del('jf:boxsets:v1');
      (jf() as unknown as { boxsetIndexBuild: null }).boxsetIndexBuild = null;
    }
  });

  it('final review I1: a failing box set is skipped, the others still count and the partial index is cached', async () => {
    await env.kv.del('jf:boxsets:v1');
    (jf() as unknown as { boxsetIndexBuild: null }).boxsetIndexBuild = null;
    failingSets.add(B2);
    try {
      const c = await jf().itemCollections!(adult, MOV);
      expect(c.map((x) => x.id)).toEqual([B1]);
      const cached = JSON.parse((await env.kv.get('jf:boxsets:v1'))!);
      expect(Object.keys(cached)).toEqual([B1]);
    } finally {
      failingSets.delete(B2);
      await env.kv.del('jf:boxsets:v1');
      (jf() as unknown as { boxsetIndexBuild: null }).boxsetIndexBuild = null;
    }
  });
});
