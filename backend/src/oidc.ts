import * as client from 'openid-client';
import type { Config } from './config.js';

export interface OidcClaims {
  sub: string;
  email?: string;
  name?: string;
  groups: string[];
}

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
  finish(currentUrl: URL, saved: Omit<LoginStart, 'url'>): Promise<OidcClaims>;
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
    async finish(currentUrl, saved) {
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: saved.codeVerifier,
        expectedState: saved.state,
        expectedNonce: saved.nonce,
        idTokenExpected: true,
      });
      const c = tokens.claims();
      if (!c) throw new Error('missing id_token claims');
      const groups = Array.isArray(c.groups) ? c.groups.filter((g): g is string => typeof g === 'string') : [];
      return {
        sub: c.sub,
        email: typeof c.email === 'string' ? c.email : undefined,
        name: typeof c.name === 'string' ? c.name : undefined,
        groups,
      };
    },
  };
}
