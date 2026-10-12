import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { keyFromBase64 } from '../../src/crypto.js';
import { MemoryKV } from '../../src/kv.js';
import { createMediaServer, mediaConfigProblems } from '../../src/media/index.js';
import { PlexMediaServer } from '../../src/plex/service.js';
import { cfg, ENC_KEY } from '../helpers.js';
import { PlexFake, PLEX_TOKEN, PLEX_URL } from '../plexfake.js';

const BASE = {
  PUBLIC_URL: 'https://p.example.com', DATABASE_URL: 'postgres://x@localhost/none', REDIS_URL: 'x', APP_ENC_KEY: 'k'.repeat(44), INTERNAL_SECRET: 'i'.repeat(20),
  OIDC_ISSUER: 'https://a.example.com', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', SEERR_URL: 'http://s', SEERR_API_KEY: 'k', WEBHOOK_SECRET: 'w'.repeat(20),
};

describe('MEDIA_SERVER=plex config', () => {
  it('requires PLEX_URL and PLEX_TOKEN (empty counts as missing), not the Jellyfin settings', () => {
    expect(() => loadConfig({ ...BASE, MEDIA_SERVER: 'plex' })).toThrow(/PLEX_URL/);
    expect(() => loadConfig({ ...BASE, MEDIA_SERVER: 'plex', PLEX_URL: 'http://plex:32400' })).toThrow(/PLEX_TOKEN/);
    expect(() => loadConfig({ ...BASE, MEDIA_SERVER: 'plex', PLEX_URL: 'http://plex:32400', PLEX_TOKEN: '' })).toThrow(/PLEX_TOKEN/);
    expect(() => loadConfig({ ...BASE, MEDIA_SERVER: 'plex', PLEX_URL: 'not a url', PLEX_TOKEN: 't' })).toThrow();
    const c = loadConfig({ ...BASE, MEDIA_SERVER: 'plex', PLEX_URL: 'http://plex:32400', PLEX_TOKEN: 'tok' });
    expect([c.MEDIA_SERVER, c.PLEX_URL, c.PLEX_TOKEN, c.JELLYFIN_URL]).toEqual(['plex', 'http://plex:32400', 'tok', undefined]);
    expect(mediaConfigProblems(c)).toEqual([]);
  });
  it('PLEX_TOKEN_FILE (Docker secret) is read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffplex-'));
    writeFileSync(join(dir, 'tok'), 'from-file\n');
    expect(loadConfig({ ...BASE, MEDIA_SERVER: 'plex', PLEX_URL: 'http://plex:32400', PLEX_TOKEN_FILE: join(dir, 'tok') }).PLEX_TOKEN).toBe('from-file');
  });
  it('the Jellyfin default is unaffected by empty PLEX_* lines in .env', () => {
    const c = loadConfig({ ...BASE, JELLYFIN_URL: 'http://j', JELLYFIN_ADMIN_API_KEY: 'k', PLEX_URL: '', PLEX_TOKEN: '' });
    expect([c.MEDIA_SERVER, c.PLEX_URL, c.PLEX_TOKEN]).toEqual(['jellyfin', undefined, undefined]);
  });
  it('the factory builds the Plex implementation (token only in its request headers)', async () => {
    const fake = new PlexFake();
    const ms = createMediaServer({ cfg: { ...cfg, MEDIA_SERVER: 'plex', PLEX_URL, PLEX_TOKEN }, kv: new MemoryKV(), encKey: keyFromBase64(ENC_KEY), fetchImpl: fake.fetch });
    expect(ms).toBeInstanceOf(PlexMediaServer);
    expect(ms.kind).toBe('plex');
    expect(await ms.admin.ping()).toBe(true);
    expect(fake.calls.at(-1)).toMatchObject({ path: '/identity', search: '', token: PLEX_TOKEN });
    await ((ms as PlexMediaServer).db as unknown as { end(): Promise<void> }).end();
  });
});
