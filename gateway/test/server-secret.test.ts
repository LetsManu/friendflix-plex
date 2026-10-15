// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { internalSecret, need, optional } from '../src/env.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ff-gw-secret-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('gateway INTERNAL_SECRET', () => {
  it('falls back to the bootstrap volume file when neither INTERNAL_SECRET nor INTERNAL_SECRET_FILE is set', () => {
    writeFileSync(join(dir, 'internal_secret'), `${'b'.repeat(64)}\n`);
    expect(internalSecret({ FF_GATEWAY_BOOTSTRAP_DIR: dir })).toBe('b'.repeat(64));
    expect(internalSecret({ FF_GATEWAY_BOOTSTRAP_DIR: dir, INTERNAL_SECRET: '' })).toBe('b'.repeat(64)); // compose passes ${VAR:-}
  });

  it('strips only the trailing newlines from the volume file (the writer\'s contract), not other whitespace', () => {
    writeFileSync(join(dir, 'internal_secret'), ` ${'b'.repeat(32)} \r\n`);
    expect(internalSecret({ FF_GATEWAY_BOOTSTRAP_DIR: dir })).toBe(` ${'b'.repeat(32)} `);
    writeFileSync(join(dir, 'internal_secret'), `${'b'.repeat(32)}\n\r\n\n`);
    expect(internalSecret({ FF_GATEWAY_BOOTSTRAP_DIR: dir })).toBe('b'.repeat(32));
  });

  it('env and VAR_FILE win over the volume file', () => {
    writeFileSync(join(dir, 'internal_secret'), 'b'.repeat(64));
    writeFileSync(join(dir, 'secret_file'), 'f'.repeat(32));
    expect(internalSecret({ FF_GATEWAY_BOOTSTRAP_DIR: dir, INTERNAL_SECRET: 'e'.repeat(32) })).toBe('e'.repeat(32));
    expect(internalSecret({ FF_GATEWAY_BOOTSTRAP_DIR: dir, INTERNAL_SECRET: 'e'.repeat(32), INTERNAL_SECRET_FILE: join(dir, 'secret_file') }))
      .toBe('f'.repeat(32));
  });

  it('without env and file it fails naming the file and the fix', () => {
    expect(() => internalSecret({ FF_GATEWAY_BOOTSTRAP_DIR: dir })).toThrow(
      `missing env INTERNAL_SECRET and bootstrap file ${join(dir, 'internal_secret')}: start the stack with docker compose up (the bootstrap service creates it)`);
  });

  it('an unreadable volume file is an error naming the file', () => {
    mkdirSync(join(dir, 'internal_secret')); // EISDIR stands in for EACCES (the tests may run as root)
    expect(() => internalSecret({ FF_GATEWAY_BOOTSTRAP_DIR: dir })).toThrow(`bootstrap file ${join(dir, 'internal_secret')} is not readable (EISDIR)`);
  });

  it('need reads VAR or VAR_FILE and refuses an unset value', () => {
    writeFileSync(join(dir, 'u'), ' http://jf:8096 \n');
    expect(need({ JELLYFIN_URL_FILE: join(dir, 'u') }, 'JELLYFIN_URL')).toBe('http://jf:8096');
    expect(need({ BACKEND_URL: 'http://backend:3000' }, 'BACKEND_URL')).toBe('http://backend:3000');
    expect(() => need({}, 'JELLYFIN_URL')).toThrow('missing env JELLYFIN_URL');
  });

  it('optional reads VAR or VAR_FILE; unset or empty is undefined (the URL then comes from the backend)', () => {
    writeFileSync(join(dir, 'u'), 'http://jf:8096\n');
    expect(optional({ JELLYFIN_URL_FILE: join(dir, 'u') }, 'JELLYFIN_URL')).toBe('http://jf:8096');
    expect(optional({ JELLYFIN_URL: 'http://jf:8096' }, 'JELLYFIN_URL')).toBe('http://jf:8096');
    expect(optional({ JELLYFIN_URL: '' }, 'JELLYFIN_URL')).toBeUndefined();
    expect(optional({}, 'JELLYFIN_URL')).toBeUndefined();
  });
});
