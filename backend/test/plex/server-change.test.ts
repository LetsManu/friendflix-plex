// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlexMediaServer } from '../../src/plex/service.js';
import { ADMIN, makeEnv, type TestEnv } from '../helpers.js';
import { fixture, PLEX_TOKEN, PLEX_URL, PlexFake } from '../plexfake.js';

/**
 * fork (final review M1): a PLEX_URL saved through PUT /api/admin/settings for another Plex server, end to end on the real live ctx:
 * the save needs a recent re-authentication (a saved token would go to a new host), then the settings change rebuilds the media
 * server (createMediaServer via the live ctx), the new instance calls only the new host, its first pass resets the old server's
 * library mirror (Task 8 guard) and /internal/gateway-config answers the new address.
 */
const NEW_HOST = 'plex2.example.com:32400';
const NEW_URL = `http://${NEW_HOST}`;
const OTHER_ID = 'another-plex-server-0000000000000000000';

describe('fork: PLEX_URL saved for another Plex server (re-auth, live rebuild, mirror reset, gateway)', () => {
  const old = new PlexFake();
  /** the other server: only a TV section with one show of its own under a rating key the old mirror also has */
  const other = new PlexFake();
  other.machineIdentifier = OTHER_ID;
  other.sections = other.sections.filter((s) => s.title === 'TV');
  for (const [k, m] of [...other.items]) if (m.librarySectionID === 1) other.items.delete(k);
  other.items.get('3')!.title = 'Other Show';
  const hostOf = (i: RequestInfo | URL) => new URL(i instanceof Request ? i.url : String(i)).host;
  /** the network: NEW_HOST is the other server, everything else the old one (media instances and the settings probe alike) */
  const net = (async (i: RequestInfo | URL, init?: RequestInit) => (hostOf(i) === NEW_HOST ? other.fetch(i, init) : old.fetch(i, init))) as typeof fetch;
  let env: TestEnv;
  let admin: { cookies: Record<string, string>; csrf: string };
  beforeAll(async () => {
    env = await makeEnv({}, { server: 'plex', plexFake: old, plexFetch: () => net, ctxPatch: (c) => { c.fetchImpl = net; } });
    admin = await env.login(ADMIN);
  });
  afterAll(() => env.close());
  const put = (values: Record<string, unknown>) =>
    env.app.inject({ method: 'PUT', url: '/api/admin/settings', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { values } });
  const stamp = async (at: number) => {
    const key = `sess:${admin.cookies.ff_sid}`;
    await env.kv.set(key, JSON.stringify({ ...JSON.parse((await env.kv.get(key))!), reauthAt: at }), 600);
  };
  const ids = async () => (await env.pool.query("select v #>> '{}' id from plex_sync_state where k = 'machine_identifier'")).rows[0]?.id;
  const keys = async () => (await env.pool.query('select rating_key from plex_items order by rating_key')).rows.map((r) => String(r.rating_key));

  it('401 without a recent re-authentication (nothing sent to the new host); after it: saved, rebuilt, mirror reset, gateway on the new URL', async () => {
    const before = env.ctx.jf;
    expect(await ids()).toBe(fixture('identity').MediaContainer.machineIdentifier);
    expect(await keys()).toContain('1'); // a movie of the old server

    // a stale session: the saved PLEX_TOKEN would go to a new host, so the save needs a re-authentication
    await stamp(Date.now() - 20 * 60_000);
    other.calls.length = 0;
    const stale = await put({ PLEX_URL: NEW_URL });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toEqual({ error: 'reauth_required' });
    expect(other.calls).toEqual([]);
    expect(env.ctx.cfg.PLEX_URL).toBe(PLEX_URL);
    expect(env.ctx.jf).toBe(before);

    // re-authenticated: the probe checks the new host, the save goes through
    await stamp(Date.now());
    const r = await put({ PLEX_URL: NEW_URL });
    expect(r.statusCode).toBe(200);
    expect(other.calls.map((c) => c.path)).toEqual(['/identity', '/library/sections', '/status/sessions']);
    expect(env.ctx.cfg.PLEX_URL).toBe(NEW_URL);

    // the live ctx rebuilt the media server through createMediaServer; the new instance talks only to the new host
    await expect.poll(() => env.ctx.jf !== before).toBe(true);
    const ms = env.ctx.jf as PlexMediaServer;
    old.calls.length = 0;
    other.calls.length = 0;
    await ms.sync.run();
    expect(old.calls).toEqual([]);
    expect(other.calls.length).toBeGreaterThan(0);
    expect(other.calls.every((c) => c.token === undefined || c.token === PLEX_TOKEN)).toBe(true);

    // Task 8: another machineIdentifier -> the old mirror is gone, the new server's library is there
    expect(await ids()).toBe(OTHER_ID);
    expect((await env.pool.query('select section_id, title from plex_sections')).rows).toEqual([{ section_id: 2, title: 'TV' }]);
    expect(await keys()).not.toContain('1');
    expect((await env.pool.query('select title from plex_items where rating_key = 3')).rows[0].title).toBe('Other Show');

    // the gateway follows the new address (the token only in upstreamAuth)
    const gw = await env.app.inject({ method: 'GET', url: '/internal/gateway-config', headers: { 'x-internal-secret': env.ctx.cfg.INTERNAL_SECRET } });
    expect(gw.json()).toEqual({ rev: env.ctx.settings.rev(), upstreamUrl: NEW_URL, upstreamAuth: { PLEX_TOKEN } });
    for (const b of [stale.body, r.body]) expect(b).not.toContain(PLEX_TOKEN);
  });
});
