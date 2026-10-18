// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildKind, channelUpdate, envLine, isCiSha, runningChannel, versionLabel } from '../src/channel.js';
import type { Ctx } from '../src/ctx.js';
import { makeEnv, type TestEnv } from './helpers.js';

const TAG = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const NEWER = 'd'.repeat(40);

describe('channel logic', () => {
  it('release vs nightly vs dev: a release build is exactly the commit of tag v<version>', () => {
    expect(isCiSha(TAG)).toBe(true);
    expect(isCiSha('dev')).toBe(false);
    expect(isCiSha('abc1234')).toBe(false); // CI bakes the full sha
    expect(isCiSha(TAG.toUpperCase())).toBe(false);
    expect(buildKind(TAG, TAG)).toBe('release');
    expect(buildKind(MAIN, TAG)).toBe('nightly');
    expect(buildKind(MAIN, null)).toBe('nightly'); // the version has no tag (yet)
    expect(buildKind(MAIN, undefined)).toBeNull(); // GitHub unreachable: unknown
    expect(buildKind('dev', TAG)).toBe('dev');
    expect(buildKind('dev', undefined)).toBe('dev');
    expect([runningChannel('release'), runningChannel('nightly'), runningChannel('dev'), runningChannel(null)]).toEqual(['stable', 'nightly', null, null]);
  });

  it('version string: "-nightly · sha7" only for a nightly CI build', () => {
    expect(versionLabel('1.1.0', 'abc1234def'.padEnd(40, '0'), 'nightly')).toBe('1.1.0-nightly · abc1234');
    expect(versionLabel('1.1.0', TAG, 'release')).toBe('1.1.0');
    expect(versionLabel('1.1.0', 'dev', 'dev')).toBe('1.1.0');
    expect(versionLabel('1.1.0', MAIN, null)).toBe('1.1.0');
  });

  it('update available per channel', () => {
    // stable: only a newer release counts, commits on main never do
    expect(channelUpdate('stable', { releaseNewer: true, behind: 0 })).toBe(true);
    expect(channelUpdate('stable', { releaseNewer: false, behind: 12 })).toBe(false);
    expect(channelUpdate('stable', { releaseNewer: null, behind: 3 })).toBeNull();
    // nightly: newer commits on main than the installed sha
    expect(channelUpdate('nightly', { releaseNewer: false, behind: 3 })).toBe(true);
    expect(channelUpdate('nightly', { releaseNewer: true, behind: 0 })).toBe(false);
    expect(channelUpdate('nightly', { releaseNewer: null, behind: null })).toBeNull();
  });

  it('the .env line per channel', () => {
    expect(envLine('stable')).toBe('FF_TAG=latest');
    expect(envLine('nightly')).toBe('FF_TAG=nightly');
  });
});

describe('admin update + /api/version with channels', () => {
  let env: TestEnv;
  let calls: string[];
  /** commit of tag v1.1.0 as GitHub answers it: null = 404, 'annotated' = a tag object that points at TAG */
  let tag: string | null | 'annotated' | 'fail';
  let behind: number;
  let release: string;
  afterEach(() => env?.close());

  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  async function setup(cfg: Record<string, unknown>) {
    env = await makeEnv({}, { ctxPatch: (c: Ctx) => { c.cfg = { ...c.cfg, APP_VERSION: '1.1.0', APP_CODENAME: 'Arancini', ...cfg }; } });
    env.ctx.fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/git/ref/tags/v1.1.0')) {
        if (tag === 'fail') return json({}, 500);
        if (tag === null) return json({ message: 'Not Found' }, 404);
        return json({ ref: 'refs/tags/v1.1.0', object: tag === 'annotated' ? { type: 'tag', sha: 'f'.repeat(40) } : { type: 'commit', sha: tag } });
      }
      if (url.endsWith(`/git/tags/${'f'.repeat(40)}`)) return json({ object: { type: 'commit', sha: TAG } });
      if (url.endsWith('/releases/latest')) return json({ tag_name: release, name: release, html_url: 'https://github.com/x/r', published_at: '2026-10-01T00:00:00Z', body: '- x', draft: false, prerelease: false });
      if (url.includes('/actions/workflows/ci.yml/runs')) return json({ workflow_runs: [{ head_sha: NEWER, updated_at: '2026-10-02T00:00:00Z', html_url: 'https://github.com/x/runs/1' }] });
      if (url.includes('/compare/')) return json({ ahead_by: behind, commits: [] });
      return json({}, 404);
    }) as never;
    const admin = await env.login();
    return (q = '') => env.app.inject({ url: `/api/admin/update${q}`, cookies: admin.cookies }).then((r) => r.json());
  }
  const reset = () => { calls = []; tag = TAG; behind = 0; release = 'v1.1.0'; };

  it('a release build on the default stable channel: up to date while main moves on', async () => {
    reset(); behind = 4;
    const get = await setup({ GIT_SHA: TAG });
    const b = await get();
    expect(b.channel).toEqual({ selected: 'stable', running: 'stable', build: 'release', label: '1.1.0', locked: false, envLine: 'FF_TAG=latest' });
    expect(b.updateAvailable).toBe(false);
    expect(b.behind).toBe(4); // secondary info only
    expect((await env.app.inject('/api/version')).json()).toMatchObject({ build: 'release', channel: 'stable', label: '1.1.0' });
  });

  it('nightly selected on a release build: commits on main are the update, the .env line follows the selection', async () => {
    reset(); behind = 4;
    const get = await setup({ GIT_SHA: TAG, UPDATE_CHANNEL: 'nightly' });
    const b = await get();
    expect(b.channel).toMatchObject({ selected: 'nightly', running: 'stable', envLine: 'FF_TAG=nightly' });
    expect(b.updateAvailable).toBe(true);
  });

  it('a nightly build: label with the sha; stable ignores commits, a newer release is an update', async () => {
    reset(); behind = 2;
    const get = await setup({ GIT_SHA: MAIN, UPDATE_CHANNEL: 'nightly' });
    const b = await get();
    expect(b.channel).toMatchObject({ selected: 'nightly', running: 'nightly', build: 'nightly', label: '1.1.0-nightly · bbbbbbb' });
    expect(b.updateAvailable).toBe(true);
    await env.close();
    reset(); release = 'v1.2.0'; behind = 0;
    const stable = await setup({ GIT_SHA: MAIN });
    expect(await stable()).toMatchObject({ updateAvailable: true, channel: { selected: 'stable', running: 'nightly' } });
  });

  it('annotated tags are peeled; the tag answer is cached like the update check', async () => {
    reset(); tag = 'annotated';
    const get = await setup({ GIT_SHA: TAG });
    expect((await get()).channel.build).toBe('release');
    const tagCalls = () => calls.filter((u) => u.includes('/git/')).length;
    expect(tagCalls()).toBe(2);
    await get();
    await env.app.inject('/api/version');
    expect(tagCalls()).toBe(2);
    await get('?refresh=1');
    expect(tagCalls()).toBe(4);
  });

  it('no tag for the version: nightly; GitHub failing: unknown, the plain version, never a 500', async () => {
    reset(); tag = null;
    let get = await setup({ GIT_SHA: MAIN });
    expect((await get()).channel).toMatchObject({ build: 'nightly', running: 'nightly' });
    await env.close();
    reset(); tag = 'fail';
    get = await setup({ GIT_SHA: MAIN });
    const b = await get();
    expect(b.channel).toMatchObject({ build: null, running: null, label: '1.1.0' });
    const v = await env.app.inject('/api/version');
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ build: null, channel: null, label: '1.1.0' });
  });

  it('a local dev build asks GitHub nothing about tags and keeps its version text', async () => {
    reset();
    const get = await setup({ GIT_SHA: 'dev' });
    expect((await get()).channel).toMatchObject({ build: 'dev', running: null, label: '1.1.0' });
    expect((await env.app.inject('/api/version')).json()).toEqual({ sha: 'dev', version: '1.1.0', codename: 'Arancini', build: 'dev', channel: null, label: '1.1.0' });
    expect(calls.some((u) => u.includes('/git/'))).toBe(false);
  });

  it('the switch saves UPDATE_CHANNEL through the settings', async () => {
    reset();
    const get = await setup({ GIT_SHA: TAG });
    const admin = await env.login();
    const r = await env.app.inject({ method: 'PUT', url: '/api/admin/settings', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { values: { UPDATE_CHANNEL: 'nightly' } } });
    expect(r.statusCode).toBe(200);
    expect((await env.pool.query("select key from settings where key = 'UPDATE_CHANNEL'")).rowCount).toBe(1);
    const bad = await env.app.inject({ method: 'PUT', url: '/api/admin/settings', cookies: admin.cookies, headers: { 'x-csrf-token': admin.csrf }, payload: { values: { UPDATE_CHANNEL: 'latest' } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors).toEqual({ UPDATE_CHANNEL: 'invalid_option' });
    void get;
  });
});
