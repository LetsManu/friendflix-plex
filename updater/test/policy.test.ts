// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FF_SERVICES, HEALTH_SERVICES, channelTag, cosignIdentity, expectedImage, isRepo, isTag, parseChannelBody, pinnedRef, shaTag } from '../src/policy.js';

describe('updater policy', () => {
  it('the service whitelist is FriendFlix only', () => {
    expect([...FF_SERVICES]).toEqual(['bootstrap', 'backend', 'gateway', 'web']);
    expect([...HEALTH_SERVICES]).toEqual(['backend', 'gateway', 'web']);
    for (const never of ['postgres', 'redis', 'jellyfin', 'plex', 'requests', 'authentik', 'server', 'docker-proxy']) expect(FF_SERVICES as readonly string[]).not.toContain(never);
  });

  it('tags: only latest, nightly, X.Y.Z and sha-<7 hex>', () => {
    for (const ok of ['latest', 'nightly', '1.2.3', '0.0.0', '10.20.30', 'sha-abc1234']) expect(isTag(ok), ok).toBe(true);
    for (const bad of ['', 'Latest', 'v1.2.3', '1.2', '1.2.3-rc.1', '01.2.3', 'sha-abc123', 'sha-ABC1234', 'sha-abc12345', 'latest;rm -rf /',
      '1.2.3\n', '../x', 'nightly ', '$(id)', 'edge', 123, null]) expect(isTag(bad), String(bad)).toBe(false);
  });

  it('channel -> tag', () => {
    expect(channelTag('stable')).toBe('latest');
    expect(channelTag('nightly')).toBe('nightly');
    expect(channelTag('pinned', '1.4.2')).toBe('1.4.2');
    expect(channelTag('pinned', 'latest')).toBeNull();
    expect(channelTag('pinned', null)).toBeNull();
    expect(shaTag('a'.repeat(40))).toBe('sha-aaaaaaa');
    expect(shaTag('dev')).toBeNull();
    expect(shaTag(undefined)).toBeNull();
  });

  it('channel body: exactly the known shapes, never a free-form tag', () => {
    expect(parseChannelBody({ channel: 'stable' })).toEqual({ channel: 'stable', version: null });
    expect(parseChannelBody({ channel: 'nightly' })).toEqual({ channel: 'nightly', version: null });
    expect(parseChannelBody({ channel: 'pinned', version: '1.2.3' })).toEqual({ channel: 'pinned', version: '1.2.3' });
    for (const bad of [null, [], 'stable', {}, { channel: 'edge' }, { channel: 'stable', version: '1.2.3' }, { channel: 'pinned' },
      { channel: 'pinned', version: 'sha-abc1234' }, { channel: 'pinned', version: 'latest' }, { channel: 'stable', tag: 'evil' },
      { channel: 'stable', service: 'postgres' }, { channel: 'pinned', version: '1.2.3', image: 'evil/x' }]) expect(parseChannelBody(bad), JSON.stringify(bad)).toBeNull();
  });

  it('expected image names follow the repository (lowercase, like publish.yml); bootstrap runs the backend image', () => {
    expect(expectedImage('LetsManu/friendflix', 'backend', 'latest')).toBe('ghcr.io/letsmanu/friendflix-backend:latest');
    expect(expectedImage('LetsManu/friendflix', 'bootstrap', '1.2.3')).toBe('ghcr.io/letsmanu/friendflix-backend:1.2.3');
    expect(expectedImage('Bob/FriendFlix-Plex', 'web', 'nightly')).toBe('ghcr.io/bob/friendflix-plex-web:nightly');
    expect(isRepo('LetsManu/friendflix')).toBe(true);
    for (const bad of ['', 'a', 'a/b/c', '../x', 'a/..', 'a b/c', 'a/b;c']) expect(isRepo(bad), bad).toBe(false);
  });

  it('fork: the default repository names the friendflix-plex-* images, never upstream\'s', () => {
    expect(expectedImage('LetsManu/friendflix-plex', 'bootstrap', 'latest')).toBe('ghcr.io/letsmanu/friendflix-plex-backend:latest');
    expect(expectedImage('LetsManu/friendflix-plex', 'gateway', '1.2.3')).toBe('ghcr.io/letsmanu/friendflix-plex-gateway:1.2.3');
    expect(expectedImage('LetsManu/friendflix-plex', 'updater', 'nightly')).toBe('ghcr.io/letsmanu/friendflix-plex-updater:nightly');
  });

  it('fork: cosign identity is the fork\'s publish.yml; upstream\'s signature does not match', () => {
    const re = new RegExp(cosignIdentity('LetsManu/friendflix-plex').identityRegexp);
    expect(re.test('https://github.com/LetsManu/friendflix-plex/.github/workflows/publish.yml@refs/heads/main')).toBe(true);
    expect(re.test('https://github.com/LetsManu/friendflix-plex/.github/workflows/publish.yml@refs/tags/v1.1.0')).toBe(true);
    for (const bad of [
      'https://github.com/LetsManu/friendflix/.github/workflows/publish.yml@refs/heads/main',
      'https://github.com/LetsManu/friendflix-plexX/.github/workflows/publish.yml@refs/heads/main',
      'https://github.com/LetsManu/friendflix-plex/.github/workflows/ci.yml@refs/heads/main',
    ]) expect(re.test(bad), bad).toBe(false);
  });

  it('cosign identity: publish.yml of this repo on main or a release tag only', () => {
    const { identityRegexp, issuer } = cosignIdentity('LetsManu/friendflix');
    expect(issuer).toBe('https://token.actions.githubusercontent.com');
    const re = new RegExp(identityRegexp);
    expect(re.test('https://github.com/LetsManu/friendflix/.github/workflows/publish.yml@refs/heads/main')).toBe(true);
    expect(re.test('https://github.com/LetsManu/friendflix/.github/workflows/publish.yml@refs/tags/v1.2.3')).toBe(true);
    for (const bad of [
      'https://github.com/LetsManu/friendflix/.github/workflows/publish.yml@refs/heads/feature',
      'https://github.com/LetsManu/friendflix/.github/workflows/ci.yml@refs/heads/main',
      'https://github.com/evil/friendflix/.github/workflows/publish.yml@refs/heads/main',
      'https://github.com/LetsManuXfriendflix/.github/workflows/publish.yml@refs/heads/main',
      'https://github.com/LetsManu/friendflix/.github/workflows/publish.yml@refs/tags/v1.2.3-evil',
      'https://github.com/LetsManu/friendflix/.github/workflows/publish.yml@refs/pull/1/merge',
    ]) expect(re.test(bad), bad).toBe(false);
  });

  it('pinned ref: only the expected repository with a sha256 digest', () => {
    const img = 'ghcr.io/letsmanu/friendflix-backend:latest';
    const d = 'sha256:' + 'b'.repeat(64);
    expect(pinnedRef(img, [`ghcr.io/evil/friendflix-backend@${d}`, `ghcr.io/letsmanu/friendflix-backend@${d}`])).toBe(`ghcr.io/letsmanu/friendflix-backend@${d}`);
    expect(pinnedRef(img, [`ghcr.io/evil/friendflix-backend@${d}`])).toBeNull();
    expect(pinnedRef(img, ['ghcr.io/letsmanu/friendflix-backend@sha256:short'])).toBeNull();
    expect(pinnedRef(img, [])).toBeNull();
  });
});
