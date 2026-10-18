// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Request signing between the backend and the updater (docs/security.md "Updater"). The backend keeps a copy of `sign` in
 * backend/src/updater.ts; test-vectors/updater-hmac.json pins both to the same bytes.
 *
 *   key       = HMAC-SHA256(INTERNAL_SECRET, "friendflix-updater/v1")   (domain separation: never the raw shared secret)
 *   canonical = METHOD "\n" PATH "\n" TS "\n" NONCE "\n" hex(SHA256(body))
 *   headers   x-ff-updater-ts (unix ms), x-ff-updater-nonce (32 hex), x-ff-updater-signature ("v1=" + hex HMAC(key, canonical))
 *
 * The updater accepts a request only inside a 60 s window around its own clock, never one signed before it started (a replay
 * cache cannot outlive the process), and every nonce once.
 */
export const KEY_LABEL = 'friendflix-updater/v1';
export const HEADER_TS = 'x-ff-updater-ts';
export const HEADER_NONCE = 'x-ff-updater-nonce';
export const HEADER_SIG = 'x-ff-updater-signature';
export const WINDOW_MS = 60_000;
const NONCE_RE = /^[0-9a-f]{32}$/;
const SIG_RE = /^v1=[0-9a-f]{64}$/;
const TS_RE = /^[0-9]{13}$/;

export function deriveKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(KEY_LABEL).digest();
}

export function canonical(method: string, path: string, ts: string, nonce: string, body: string): string {
  return [method.toUpperCase(), path, ts, nonce, createHash('sha256').update(body).digest('hex')].join('\n');
}

export function sign(key: Buffer, method: string, path: string, body = '', ts = String(Date.now()), nonce = randomBytes(16).toString('hex')): Record<string, string> {
  const sig = createHmac('sha256', key).update(canonical(method, path, ts, nonce, body)).digest('hex');
  return { [HEADER_TS]: ts, [HEADER_NONCE]: nonce, [HEADER_SIG]: `v1=${sig}` };
}

export type AuthError = 'missing' | 'malformed' | 'expired' | 'bad_signature' | 'replay';

/** Remembers each nonce until its request can no longer pass the time window; refuses (fails closed) when full. */
export class ReplayCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly max = 10_000) {}
  /** true when the nonce was new (and is now remembered) */
  claim(nonce: string, expiresAt: number, now: number): boolean {
    if (this.seen.has(nonce)) return false;
    if (this.seen.size >= this.max) {
      for (const [n, exp] of this.seen) if (exp <= now) this.seen.delete(n);
      if (this.seen.size >= this.max) return false;
    }
    this.seen.set(nonce, expiresAt);
    return true;
  }
  get size(): number { return this.seen.size; }
}

export interface Verifier {
  key: Buffer;
  cache: ReplayCache;
  /** requests signed before this instant (process start) are refused */
  notBefore: number;
  now?: () => number;
}

/** Checks one request; the signature is compared in constant time before the nonce is claimed (an invalid request burns no nonce). */
export function verify(v: Verifier, req: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }): { ok: true } | { ok: false; error: AuthError } {
  const h = (k: string) => { const x = req.headers[k]; return Array.isArray(x) ? undefined : x; };
  const ts = h(HEADER_TS), nonce = h(HEADER_NONCE), sig = h(HEADER_SIG);
  if (!ts || !nonce || !sig) return { ok: false, error: 'missing' };
  if (!TS_RE.test(ts) || !NONCE_RE.test(nonce) || !SIG_RE.test(sig)) return { ok: false, error: 'malformed' };
  const now = (v.now ?? Date.now)();
  const t = Number(ts);
  if (Math.abs(now - t) > WINDOW_MS || t < v.notBefore) return { ok: false, error: 'expired' };
  const want = createHmac('sha256', v.key).update(canonical(req.method, req.path, ts, nonce, req.body)).digest();
  const got = Buffer.from(sig.slice(3), 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, error: 'bad_signature' };
  if (!v.cache.claim(nonce, t + WINDOW_MS, now)) return { ok: false, error: 'replay' };
  return { ok: true };
}
