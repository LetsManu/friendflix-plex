// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as client from 'openid-client';
import type { Config } from './config.js';
import { HttpError } from './users.js';

export interface OidcClaims {
  sub: string;
  email?: string;
  name?: string;
  groups: string[];
  /** id_token auth_time (seconds since epoch): when the person really authenticated at the IdP */
  authTime?: number;
}

/** seconds a re-authentication may be old for the forgotten-PIN reset (prompt=login is only a request to the IdP) */
export const RESET_PIN_MAX_AGE = 120;

/** true when `authTime` (seconds) is present and at most `maxAge` seconds (+ small clock skew) in the past */
export const freshAuth = (authTime: number | undefined, maxAge: number, nowMs = Date.now()): boolean =>
  typeof authTime === 'number' && Number.isFinite(authTime) && nowMs / 1000 - authTime <= maxAge + 30 && authTime - nowMs / 1000 <= 30;

export interface LoginStart {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** Abstraction over the OIDC provider (Authentik) so routes are testable. */
export interface OidcProvider {
  /** forceLogin: re-authentication (prompt=login, max_age=0), used by the forgotten-PIN reset */
  start(opts?: { forceLogin?: boolean }): Promise<LoginStart>;
  /** maxAge: the id_token must carry an auth_time at most that many seconds old (validated by openid-client) */
  finish(currentUrl: URL, saved: Omit<LoginStart, 'url'>, opts?: { maxAge?: number }): Promise<OidcClaims>;
  /** drops a cached discovery (createLazyOidc); called when PUBLIC_URL or an OIDC_* setting changes */
  reset?(): void;
}

/** after a failed discovery, logins answer 503 at once for this long before the next attempt */
export const OIDC_RETRY_MS = 30_000;

/**
 * The provider of the live config, discovered on the first start()/finish() and cached. A failed discovery (IdP down, OIDC_ISSUER not
 * set yet) never stops the backend: start()/finish() throw HttpError(503, 'oidc_unavailable') and the next attempt waits OIDC_RETRY_MS.
 * reset() (a sign-in setting changed) drops the cache and the wait; a discovery still running for the old config is not cached.
 */
export function createLazyOidc(getCfg: () => Config, opts: {
  discover?: (cfg: Config) => Promise<OidcProvider>; now?: () => number; log?: { warn(o: object, m: string): void };
} = {}): OidcProvider & { reset(): void } {
  const discover = opts.discover ?? createAuthentikProvider;
  const now = opts.now ?? Date.now;
  let gen = 0;
  let pending: Promise<OidcProvider> | undefined;
  let failedAt: number | undefined;

  const provider = (): Promise<OidcProvider> => {
    if (pending) return pending;
    if (failedAt !== undefined && now() - failedAt < OIDC_RETRY_MS) return Promise.reject(new HttpError(503, 'oidc_unavailable'));
    const mine = gen;
    const p = Promise.resolve().then(() => discover(getCfg())).catch((err: unknown) => {
      if (mine === gen) {
        pending = undefined;
        failedAt = now();
        // the issuer's error only (discovery never sends the client secret)
        opts.log?.warn({ err }, 'oidc discovery failed; sign-in answers 503 until the next attempt');
      }
      throw new HttpError(503, 'oidc_unavailable');
    });
    pending = p;
    return p;
  };

  return {
    start: async (o) => (await provider()).start(o),
    finish: async (url, saved, o) => (await provider()).finish(url, saved, o),
    reset() {
      gen++;
      pending = undefined;
      failedAt = undefined;
    },
  };
}

export async function createAuthentikProvider(cfg: Config): Promise<OidcProvider> {
  const insecure = cfg.OIDC_ALLOW_INSECURE === 'true';
  const config = await client.discovery(
    new URL(cfg.OIDC_ISSUER), cfg.OIDC_CLIENT_ID, cfg.OIDC_CLIENT_SECRET, undefined,
    insecure ? { execute: [client.allowInsecureRequests] } : undefined,
  );
  const redirect_uri = new URL('/auth/callback', cfg.PUBLIC_URL).toString();

  return {
    async start(opts) {
      const codeVerifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = client.randomNonce();
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri,
        scope: 'openid profile email groups',
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
        nonce,
        ...(opts?.forceLogin ? { prompt: 'login', max_age: '0' } : {}),
      });
      return { url: url.toString(), state, nonce, codeVerifier };
    },
    async finish(currentUrl, saved, opts) {
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: saved.codeVerifier,
        expectedState: saved.state,
        expectedNonce: saved.nonce,
        idTokenExpected: true,
        ...(opts?.maxAge !== undefined ? { maxAge: opts.maxAge } : {}),
      });
      const c = tokens.claims();
      if (!c) throw new Error('missing id_token claims');
      const groups = Array.isArray(c.groups) ? c.groups.filter((g): g is string => typeof g === 'string') : [];
      return {
        sub: c.sub,
        email: typeof c.email === 'string' ? c.email : undefined,
        name: typeof c.name === 'string' ? c.name : undefined,
        groups,
        authTime: typeof c.auth_time === 'number' ? c.auth_time : undefined,
      };
    },
  };
}
