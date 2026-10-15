// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Block 23 on Plex (makeEnv({ server: 'plex' })): the admin user detail's media server link for active and locked accounts
 * (admin.identityExists), lock / unlock / role / per-user limit overrides landing in plex_media_policies, approvals creating the
 * synthetic identity, the repair link, the final deletion (no plex_* rows left, audit scrubbed), the data export over more than
 * one history page (truncated / partial as export.ts defines them, nothing Plex-internal in the JSON) and the restore.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit } from '../../src/audit.js';
import { deletionTick, pseudonymFor, scheduleDeletion } from '../../src/deletion.js';
import type { OidcClaims } from '../../src/oidc.js';
import { createProfile } from '../../src/profiles.js';
import type { UserRow } from '../../src/types.js';
import { provisionUser } from '../../src/users.js';
import { ADMIN, makeEnv, type TestEnv } from '../helpers.js';
import { PLEX_TOKEN, PLEX_URL, PlexFake } from '../plexfake.js';

type Sess = { cookies: Record<string, string>; csrf: string };
const DAY = 86400e3;

describe('Block 23 on Plex', () => {
  let env: TestEnv;
  let admin: Sess;
  const fake = new PlexFake();
  /** 1100 episodes: enough for more than five export history pages */
  const long = fake.addShow({ title: 'Long Show', episodes: 1100 });
  const bodies: string[] = [];

  beforeAll(async () => {
    env = await makeEnv({}, { server: 'plex', plexFake: fake });
    admin = await env.login();
  }, 60_000);
  afterAll(async () => {
    for (const b of bodies) {
      expect(b).not.toContain(PLEX_TOKEN);
      expect(b).not.toContain(PLEX_URL);
    }
    await env.close();
  });

  const call = async (s: Sess, method: string, url: string, body?: unknown) => {
    const r = await env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
    bodies.push(r.body);
    return r;
  };
  const as = (method: string, url: string, body?: unknown) => call(admin, method, url, body);
  let n = 0;
  /** a provisioned account (synthetic owner identity) with one more profile (its own identity) */
  async function account(role = 'friend'): Promise<{ user: UserRow; claims: OidcClaims; ids: string[] }> {
    const k = ++n;
    const claims: OidcClaims = { sub: `plex-sub-${k}`, email: `person${k}@example.com`, name: `Person${k}`, groups: [] };
    const user = await provisionUser(env.ctx, claims, role);
    const p = await createProfile(env.ctx, user, { name: 'Second' });
    return { user, claims, ids: [user.jellyfin_user_id, p.jellyfin_user_id!] };
  }
  const policies = async (ids: string[]) => (await env.pool.query<{ identity_id: string; disabled: boolean; max_streams: number | null; max_bitrate: number | null; download: boolean; hidden: boolean }>(
    'select identity_id, disabled, max_streams, max_bitrate, download, hidden from plex_media_policies where identity_id = any($1) order by array_position($1, identity_id)', [ids])).rows;
  const plexRows = async (ids: string[]) => ({
    identities: (await env.pool.query('select id from plex_identities where id = any($1)', [ids])).rowCount,
    policies: (await env.pool.query('select 1 from plex_media_policies where identity_id = any($1)', [ids])).rowCount,
    userdata: (await env.pool.query('select 1 from plex_userdata where identity_id = any($1)', [ids])).rowCount,
  });
  /** `count` played episodes of the long show for one identity, newest first in show order */
  const played = (identity: string, count: number) => env.pool.query(
    `insert into plex_userdata(identity_id, rating_key, played, play_count, last_played)
     select $1, rk::bigint, true, 1, now() - (ord || ' minutes')::interval from unnest($2::text[]) with ordinality t(rk, ord)
     on conflict do nothing`, [identity, long.episodes.slice(0, count)]);
  const link = async (id: string) => (await as('GET', `/api/admin/users/${id}`)).json().linked.jellyfin as { ok: boolean | null; username: string };

  describe('admin user detail and account actions', () => {
    it('identityExists reads the synthetic identity, locked or not, and never creates one', async () => {
      const { ids } = await account();
      const ex = env.ctx.jf.admin.identityExists!;
      expect(ex).toBeTypeOf('function');
      expect(await ex(ids[0]!)).toBe(true);
      await env.ctx.jf.admin.setDisabled(ids[0]!, true);
      expect(await ex(ids[0]!)).toBe(true);
      expect(await ex('f'.repeat(32))).toBe(false);
      expect((await env.pool.query('select 1 from plex_identities where id = $1', ['f'.repeat(32)])).rowCount).toBe(0);
    });

    it('the media server link is ok for an active and a locked account; a lost identity (active or locked) shows broken until a repair', async () => {
      const { user, ids } = await account();
      expect(await link(user.id)).toEqual({ ok: true, username: user.jellyfin_username });

      // active account, identity lost: broken (Plex views() would answer [] and read ok); a repair brings it back
      await env.pool.query('delete from plex_identities where id = $1', [ids[0]]);
      expect((await link(user.id)).ok).toBe(false);
      expect((await as('POST', `/api/admin/users/${user.id}/repair`)).json().jellyfin).toEqual({ identities: 2, failed: 0 });
      expect((await policies(ids)).map((p) => p.disabled)).toEqual([false, false]);
      expect(await link(user.id)).toEqual({ ok: true, username: user.jellyfin_username });

      expect((await as('PATCH', `/api/admin/users/${user.id}`, { disabled: true })).statusCode).toBe(200);
      expect((await policies(ids)).map((p) => p.disabled)).toEqual([true, true]);
      expect(await link(user.id)).toEqual({ ok: true, username: user.jellyfin_username });

      // the identity is gone (e.g. lost in a restore of the database): the locked account's link is broken
      await env.pool.query('delete from plex_identities where id = $1', [ids[0]]);
      expect((await link(user.id)).ok).toBe(false);
      // repair re-applies the role policy: identity and its (still locked) policy are back, the link is healthy again
      const r = await as('POST', `/api/admin/users/${user.id}/repair`);
      expect(r.statusCode).toBe(200);
      expect(r.json().jellyfin).toEqual({ identities: 2, failed: 0 }); // (the fake request service knows no user: requests.ok false)
      expect(await plexRows([ids[0]!])).toMatchObject({ identities: 1, policies: 1 });
      expect((await policies(ids)).map((p) => p.disabled)).toEqual([true, true]);
      expect((await link(user.id)).ok).toBe(true);

      expect((await as('PATCH', `/api/admin/users/${user.id}`, { disabled: false })).statusCode).toBe(200);
      expect((await policies(ids)).map((p) => p.disabled)).toEqual([false, false]);
      expect(await link(user.id)).toEqual({ ok: true, username: user.jellyfin_username });
      // unlocked: the account sees the libraries again
      expect((await env.ctx.jf.views(user)).length).toBeGreaterThan(0);
    });

    it('bulk lock / unlock reach every identity of the account', async () => {
      const { user, ids } = await account();
      expect((await as('POST', '/api/admin/users/bulk', { ids: [user.id], action: 'lock' })).json()).toEqual({ done: 1 });
      expect((await policies(ids)).map((p) => p.disabled)).toEqual([true, true]);
      expect((await as('POST', '/api/admin/users/bulk', { ids: [user.id], action: 'unlock' })).json()).toEqual({ done: 1 });
      expect((await policies(ids)).map((p) => p.disabled)).toEqual([false, false]);
    });

    it('a role change and per-user limit overrides land in plex_media_policies for owner and profile identity', async () => {
      const { user, ids } = await account('friend');
      expect((await policies(ids)).map(({ max_streams, max_bitrate, download, hidden }) => ({ max_streams, max_bitrate, download, hidden }))).toEqual([
        { max_streams: 2, max_bitrate: 20_000_000, download: false, hidden: false },
        { max_streams: 2, max_bitrate: 20_000_000, download: false, hidden: true },
      ]);
      expect((await as('PATCH', `/api/admin/users/${user.id}`, { role: 'family' })).statusCode).toBe(200);
      expect((await policies(ids)).map(({ max_streams, max_bitrate, download, hidden }) => ({ max_streams, max_bitrate, download, hidden }))).toEqual([
        { max_streams: 4, max_bitrate: 40_000_000, download: true, hidden: false },
        { max_streams: 4, max_bitrate: 40_000_000, download: true, hidden: true },
      ]);

      const put = await as('PUT', `/api/admin/users/${user.id}/limits`, { maxStreams: 1, remoteBitrate: 2_000_000 });
      expect(put.statusCode, put.body).toBe(200);
      expect((await policies(ids)).map((p) => p.max_streams)).toEqual([1, 1]);
      // the limit the Plex playback wrapper enforces reads exactly this column (PlexLimits.policy)
      expect((await env.pool.query('select max_streams from plex_media_policies where identity_id = $1', [ids[0]])).rows[0].max_streams).toBe(1);
      // back to the role
      expect((await as('PUT', `/api/admin/users/${user.id}/limits`, { maxStreams: null })).statusCode).toBe(200);
      expect((await policies(ids)).map((p) => p.max_streams)).toEqual([4, 4]);
    });

    it('approving a request creates the synthetic identity with the chosen role', async () => {
      const id = '0b8c6a52-1d6e-4c1a-9a7e-3f1f6a2b9c01';
      await env.pool.query("insert into approval_requests(id, authentik_sub, email, name) values ($1, 'plex-pending', 'pending@example.com', 'Pending Person')", [id]);
      const r = await as('POST', `/api/admin/approvals/${id}/approve`, { role: 'guest' });
      expect(r.statusCode, r.body).toBe(200);
      const u = (await env.pool.query('select id, role, jellyfin_user_id from users where id = $1', [r.json().id])).rows[0];
      expect(u.role).toBe('guest');
      expect(u.jellyfin_user_id).toMatch(/^[0-9a-f]{32}$/);
      expect(await plexRows([u.jellyfin_user_id])).toEqual({ identities: 1, policies: 1, userdata: 0 });
      expect((await env.pool.query('select max_age, max_streams, disabled from plex_media_policies where identity_id = $1', [u.jellyfin_user_id])).rows[0])
        .toEqual({ max_age: 12, max_streams: 1, disabled: false });
      expect(await link(u.id)).toEqual({ ok: true, username: expect.any(String) });
    });

    it('activity tab lists the Plex history of every profile', async () => {
      const { user, ids } = await account();
      await played(ids[1]!, 3);
      const r = await as('GET', `/api/admin/users/${user.id}/activity?limit=10`);
      expect(r.statusCode).toBe(200);
      expect(r.json().skipped).toEqual([]);
      expect(r.json().items.map((i: { profile: { name: string } }) => i.profile.name)).toEqual(['Second', 'Second', 'Second']);
    });
  });

  describe('deletion and restore', () => {
    it('the final deletion leaves no Plex rows for the account and scrubs its audit entries', async () => {
      const { user, claims, ids } = await account();
      await played(ids[0]!, 5);
      await played(ids[1]!, 2);
      await audit(env.ctx, null, 'user.repair', user.id, { name: claims.name, email: claims.email });
      expect(await plexRows(ids)).toEqual({ identities: 2, policies: 2, userdata: 7 });

      await scheduleDeletion(env.ctx, null, user.id, new Date(Date.now() - 8 * DAY));
      expect((await policies(ids)).map((p) => p.disabled)).toEqual([true, true]);
      expect(await link(user.id)).toEqual({ ok: true, username: user.jellyfin_username });

      const r = await deletionTick(env.ctx);
      expect(r).toMatchObject({ claimed: 1, finished: 1, failed: 0 });
      expect(await plexRows(ids)).toEqual({ identities: 0, policies: 0, userdata: 0 });
      expect((await env.pool.query('select 1 from users where id = $1', [user.id])).rowCount).toBe(0);
      expect((await env.pool.query('select step, finished_at is not null done, jellyfin_ids from account_deletions where user_id = $1', [user.id])).rows[0])
        .toEqual({ step: 6, done: true, jellyfin_ids: null });

      const pseudonym = pseudonymFor(env.ctx, user.id);
      const rows = (await env.pool.query<{ action: string; meta: Record<string, unknown> }>('select action, meta from audit_log where target = $1 or actor = $1::uuid order by id', [user.id])).rows;
      expect(rows.length).toBeGreaterThan(0);
      const text = JSON.stringify(rows);
      for (const s of [claims.name!, claims.email!, user.jellyfin_username]) expect(text).not.toContain(s);
      expect(rows.find((x) => x.action === 'user.repair')!.meta).toEqual({ pseudonym });
      expect(rows.at(-1)).toMatchObject({ action: 'user.deleted', meta: { pseudonym, authentik: 'not_configured' } });
      // a second tick has nothing left to do and recreates nothing
      expect(await deletionTick(env.ctx)).toEqual({ claimed: 0, finished: 0, failed: 0 });
      expect(await plexRows(ids)).toEqual({ identities: 0, policies: 0, userdata: 0 });
    });

    it('a restore within the grace period re-enables every identity', async () => {
      const { user, ids } = await account();
      await scheduleDeletion(env.ctx, null, user.id);
      expect((await policies(ids)).map((p) => p.disabled)).toEqual([true, true]);
      expect(await env.ctx.jf.views(user)).toEqual([]);
      const r = await as('POST', `/api/admin/users/${user.id}/deletion/restore`);
      expect(r.statusCode, r.body).toBe(200);
      expect((await env.pool.query('select disabled, deletion_at from users where id = $1', [user.id])).rows[0]).toEqual({ disabled: false, deletion_at: null });
      expect((await policies(ids)).map((p) => p.disabled)).toEqual([false, false]);
      expect(await plexRows(ids)).toMatchObject({ identities: 2, policies: 2 });
      expect((await env.ctx.jf.views(user)).length).toBeGreaterThan(0);
      expect(await link(user.id)).toEqual({ ok: true, username: user.jellyfin_username });
    });
  });

  describe('data export', () => {
    type HistoryEntry = { profileId: string; items: Array<{ itemId: string; name: string; playedAt: string | null }>; truncated?: boolean; error?: string };
    /** signs in as the account and downloads its export (the route allows 5 an hour per account) */
    async function exportOf(claims: OidcClaims): Promise<{ raw: string; doc: { history: { profiles: HistoryEntry[]; truncated?: boolean; error?: string } } }> {
      const s = await env.login(claims);
      env.claims.current = ADMIN;
      const r = await env.app.inject({ method: 'GET', url: '/api/account/export', cookies: s.cookies });
      expect(r.statusCode, r.body).toBe(200);
      bodies.push(r.body);
      return { raw: r.body, doc: r.json() };
    }
    const assertNothingPlex = (raw: string) => {
      for (const s of [PLEX_TOKEN, PLEX_URL, 'plex.test', '/library/', 'X-Plex-Token']) expect(raw).not.toContain(s);
    };

    it('more than 200 history rows: every row, in order, not truncated, nothing Plex-internal', async () => {
      const { user, claims, ids } = await account();
      await played(ids[0]!, 250);
      await played(ids[1]!, 1);
      const { raw, doc } = await exportOf(claims);
      assertNothingPlex(raw);
      const own = doc.history.profiles.find((p) => p.profileId === user.id)!;
      expect(own.items).toHaveLength(250);
      expect(new Set(own.items.map((i) => i.itemId)).size).toBe(250);
      expect(own.items.slice(0, 3).map((i) => i.name)).toEqual(['Episode 1', 'Episode 2', 'Episode 3']); // newest first
      expect(own.items.every((i) => i.playedAt)).toBe(true);
      expect(own.truncated).toBeUndefined();
      expect(own.error).toBeUndefined();
      expect(doc.history.truncated).toBeUndefined();
      const second = doc.history.profiles.find((p) => p.profileId !== user.id)!;
      expect(second.items).toHaveLength(1);
    });

    it('more than 1000 rows: capped at 1000 and marked truncated', async () => {
      const { user, claims, ids } = await account();
      await played(ids[0]!, 1100);
      const { raw, doc } = await exportOf(claims);
      assertNothingPlex(raw);
      const own = doc.history.profiles.find((p) => p.profileId === user.id)!;
      expect(own.items).toHaveLength(1000);
      expect(new Set(own.items.map((i) => i.itemId)).size).toBe(1000);
      expect(own.truncated).toBe(true);
      expect(doc.history.truncated).toBe(true);
    });

    it('a failing later Plex page keeps the pages before it, marked partial', async () => {
      const { user, claims, ids } = await account();
      await played(ids[0]!, 450);
      const jf = env.ctx.jf;
      const orig = jf.history;
      const real = orig.bind(jf);
      const starts: number[] = [];
      jf.history = async (u, q) => {
        if (u.jellyfin_user_id === ids[0]) starts.push(q?.start ?? 0);
        if (u.jellyfin_user_id === ids[0] && q?.start === 360) throw new Error('plex down');
        return real(u, q);
      };
      try {
        const { raw, doc } = await exportOf(claims);
        assertNothingPlex(raw);
        expect(starts).toEqual([0, 160, 360]);
        const own = doc.history.profiles.find((p) => p.profileId === user.id)!;
        expect(own.items).toHaveLength(360);
        expect(own.error).toBe('partial');
        expect(own.truncated).toBeUndefined();
        expect(doc.history.error).toBeUndefined();
      } finally {
        jf.history = orig;
      }
    });
  });
});
