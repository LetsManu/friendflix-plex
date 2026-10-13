import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CODENAMES, appVersion, codenameFor, compareSemver, parseSemver } from '../src/version.js';

const root = (f: string) => JSON.parse(readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8'));

describe('version', () => {
  it('codenames mirror /codenames.json (shared with scripts/release.mjs and the web app)', () => {
    expect([...CODENAMES]).toEqual((root('codenames.json') as Array<{ name: string }>).map((c) => c.name));
  });

  it('version.json is a plain SemVer version whose codename matches its major', () => {
    const v = root('version.json') as { version: string; codename: string };
    expect(parseSemver(v.version)).not.toBeNull();
    expect(codenameFor(v.version)).toBe(v.codename);
  });

  it('parses and compares versions', () => {
    expect(parseSemver('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseSemver('1.2')).toBeNull();
    expect(parseSemver('1.2.3-rc.1')).toBeNull();
    expect(compareSemver('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', 'v1.0.0')).toBe(0);
    expect(compareSemver('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareSemver('x', '1.0.0')).toBeLessThan(0);
    expect(codenameFor('3.1.0')).toBe('Churros');
    expect(codenameFor('0.9.0')).toBeNull();
  });

  it('APP_VERSION wins, version.json is the fallback', () => {
    expect(appVersion({ APP_VERSION: 'v2.1.0' })).toEqual({ version: '2.1.0', codename: 'Brezel' });
    expect(appVersion({ APP_VERSION: '2.1.0', APP_CODENAME: 'Other' })).toEqual({ version: '2.1.0', codename: 'Other' });
    expect(appVersion({ APP_VERSION: 'garbage' })).toEqual(root('version.json'));
    expect(appVersion({})).toEqual(root('version.json'));
  });
});
