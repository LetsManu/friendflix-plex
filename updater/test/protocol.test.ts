// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HEADER_NONCE, HEADER_SIG, HEADER_TS, ReplayCache, WINDOW_MS, deriveKey, sign, verify, type Verifier } from '../src/protocol.js';

const vectors = JSON.parse(readFileSync(new URL('../../test-vectors/updater-hmac.json', import.meta.url), 'utf8')) as {
  secret: string; key: string; cases: Array<{ method: string; path: string; body: string; ts: string; nonce: string; signature: string }>;
};
const NOW = 1_760_800_000_000;
const key = deriveKey('a-long-internal-secret-value');
const mk = (o: Partial<Verifier> = {}): Verifier => ({ key, cache: new ReplayCache(), notBefore: NOW - 3_600_000, now: () => NOW, ...o });
const req = (headers: Record<string, string>, body = '', method = 'POST', path = '/v1/update') => ({ method, path, headers, body });

describe('updater request signing', () => {
  it('matches the shared test vectors (the backend tests use the same file)', () => {
    const k = deriveKey(vectors.secret);
    expect(k.toString('hex')).toBe(vectors.key);
    for (const c of vectors.cases) {
      expect(sign(k, c.method, c.path, c.body, c.ts, c.nonce)[HEADER_SIG]).toBe(c.signature);
      const v = mk({ key: k, now: () => Number(c.ts), notBefore: 0 });
      expect(verify(v, req(sign(k, c.method, c.path, c.body, c.ts, c.nonce), c.body, c.method, c.path))).toEqual({ ok: true });
    }
  });

  it('accepts a fresh signed request once; the same nonce again is a replay', () => {
    const v = mk();
    const h = sign(key, 'POST', '/v1/update', '', String(NOW));
    expect(verify(v, req(h))).toEqual({ ok: true });
    expect(verify(v, req(h))).toEqual({ ok: false, error: 'replay' });
  });

  it('refuses a wrong signature, another path, method or body, and another key', () => {
    const v = mk();
    const h = sign(key, 'POST', '/v1/update', '', String(NOW));
    expect(verify(v, req(h, '', 'POST', '/v1/rollback'))).toEqual({ ok: false, error: 'bad_signature' });
    expect(verify(v, req(h, '', 'GET'))).toEqual({ ok: false, error: 'bad_signature' });
    expect(verify(v, req(h, '{}'))).toEqual({ ok: false, error: 'bad_signature' });
    expect(verify(v, req(sign(deriveKey('another-secret-value-xyz'), 'POST', '/v1/update', '', String(NOW))))).toEqual({ ok: false, error: 'bad_signature' });
    const flipped = { ...h, [HEADER_SIG]: h[HEADER_SIG]!.replace(/.$/, (c) => (c === '0' ? '1' : '0')) };
    expect(verify(v, req(flipped))).toEqual({ ok: false, error: 'bad_signature' });
    // a refused request burns no nonce: the genuine one still passes
    expect(verify(v, req(h))).toEqual({ ok: true });
  });

  it('refuses old, future and pre-start timestamps', () => {
    const v = mk({ notBefore: NOW - 1000 });
    expect(verify(v, req(sign(key, 'POST', '/v1/update', '', String(NOW - WINDOW_MS - 1))))).toEqual({ ok: false, error: 'expired' });
    expect(verify(v, req(sign(key, 'POST', '/v1/update', '', String(NOW + WINDOW_MS + 1))))).toEqual({ ok: false, error: 'expired' });
    // signed before this process started: a captured request cannot be replayed after a restart (empty replay cache)
    expect(verify(v, req(sign(key, 'POST', '/v1/update', '', String(NOW - 2000))))).toEqual({ ok: false, error: 'expired' });
    expect(verify(v, req(sign(key, 'POST', '/v1/update', '', String(NOW - 500))))).toEqual({ ok: true });
  });

  it('refuses missing and malformed headers', () => {
    const v = mk();
    const h = sign(key, 'POST', '/v1/update', '', String(NOW));
    expect(verify(v, req({}))).toEqual({ ok: false, error: 'missing' });
    expect(verify(v, req({ ...h, [HEADER_TS]: '' }))).toEqual({ ok: false, error: 'missing' });
    expect(verify(v, req({ ...h, [HEADER_TS]: '17608e0000000' }))).toEqual({ ok: false, error: 'malformed' });
    expect(verify(v, req({ ...h, [HEADER_NONCE]: 'short' }))).toEqual({ ok: false, error: 'malformed' });
    expect(verify(v, req({ ...h, [HEADER_SIG]: h[HEADER_SIG]!.slice(3) }))).toEqual({ ok: false, error: 'malformed' });
    expect(verify(v, { method: 'POST', path: '/v1/update', body: '', headers: { ...h, [HEADER_SIG]: [h[HEADER_SIG]!, h[HEADER_SIG]!] } })).toEqual({ ok: false, error: 'missing' });
  });

  it('the replay cache fails closed when full and forgets expired nonces', () => {
    const c = new ReplayCache(2);
    expect(c.claim('a', NOW + 10, NOW)).toBe(true);
    expect(c.claim('b', NOW + 10, NOW)).toBe(true);
    expect(c.claim('c', NOW + 10, NOW)).toBe(false); // full, nothing expired
    expect(c.claim('c', NOW + 10, NOW + 11)).toBe(true); // a and b expired
    expect(c.size).toBe(1);
  });
});
