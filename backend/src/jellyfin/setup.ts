// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from 'node:crypto';
import type { MediaSetupProvider } from '../media/setup.js';
import { MediaSetupError } from '../media/types.js';
import { byStatus, fail, httpUrl, join, plainHttpUrl, smallJson } from '../settings/probeKit.js';
import { mediaBrowserHeader } from './client.js';

/**
 * Jellyfin's media setup provider (spec Parts G "Jellyfin automation" and H): the settings probe and the API key created from an
 * administrator's username and password. Reached only through media/setup.ts (the seam); imports nothing of media/index.ts at runtime.
 *
 * The password lives only in this call: it is sent once to AuthenticateByName and never stored, logged or put into an error (a
 * MediaSetupError names its code only; network errors are mapped, never passed on). The session token from the sign-in is logged out in
 * a finally block, whatever happens after it. Every request has a 5 s deadline and never follows a redirect, so the credentials and the
 * token only ever reach the host that was typed in.
 */
const TIMEOUT_MS = 5_000;
const APP_NAME = 'FriendFlix';

const isTimeout = (e: unknown) => {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
};
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const cancel = (r: Response) => void r.body?.cancel().catch(() => undefined);

interface ApiKey { AccessToken: string; AppName?: unknown; DateCreated?: unknown }

async function createApiKey(input: { url: string; username: string; password: string }, deps: { fetchImpl: typeof fetch; appVersion: string }): Promise<Record<string, string>> {
  const base = plainHttpUrl(input.url);
  if (!base) throw new MediaSetupError('invalid', 'invalid_url');
  const deviceId = `ff-setup-${randomBytes(8).toString('hex')}`;

  const call = async (method: 'GET' | 'POST', path: string, opts: { token?: string; body?: unknown } = {}): Promise<Response> => {
    const headers: Record<string, string> = {
      Authorization: mediaBrowserHeader({ device: 'Setup', deviceId, version: deps.appVersion, token: opts.token }),
      accept: 'application/json',
    };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    let r: Response;
    try {
      r = await deps.fetchImpl(join(base, path), {
        method, headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch (e) {
      throw new MediaSetupError('unreachable', isTimeout(e) ? 'timeout' : undefined);
    }
    if (r.status >= 300 && r.status < 400) {
      cancel(r);
      throw new MediaSetupError('unreachable', 'redirect');
    }
    return r;
  };

  // the deadline also covers the body: a server that stalls or resets after the headers is unreachable, never a 500
  const json = (r: Response, max: number) =>
    smallJson(r, max).catch((e: unknown) => { throw new MediaSetupError('unreachable', isTimeout(e) ? 'timeout' : 'bad_response'); });

  // 1. Jellyfin's own startup wizard must be finished (before it, there is no administrator to sign in with)
  const info = await call('GET', '/System/Info/Public');
  if (!info.ok) {
    cancel(info);
    throw new MediaSetupError('unreachable', info.status === 404 ? 'not_found' : 'upstream_error');
  }
  const pub = obj(await json(info, 64 * 1024));
  if (!pub) throw new MediaSetupError('unreachable', 'bad_response');
  if (pub.StartupWizardCompleted !== true) throw new MediaSetupError('wizard_pending');

  // 2. sign in as the administrator
  const auth = await call('POST', '/Users/AuthenticateByName', { body: { Username: input.username, Pw: input.password } });
  if (auth.status === 401 || auth.status === 403) {
    cancel(auth);
    throw new MediaSetupError('unauthorized');
  }
  if (!auth.ok) {
    cancel(auth);
    throw new MediaSetupError('unreachable', 'upstream_error');
  }
  const session = obj(await json(auth, 256 * 1024));
  const token = typeof session?.AccessToken === 'string' && session.AccessToken ? session.AccessToken : undefined;
  if (!token) throw new MediaSetupError('unexpected');

  const listKeys = async (): Promise<ApiKey[]> => {
    const r = await call('GET', '/Auth/Keys', { token });
    if (r.status === 401 || r.status === 403) {
      cancel(r);
      throw new MediaSetupError('not_admin');
    }
    if (!r.ok) {
      cancel(r);
      throw new MediaSetupError('unexpected');
    }
    const items = obj(await json(r, 1024 * 1024))?.Items;
    if (!Array.isArray(items)) throw new MediaSetupError('unexpected');
    return items.filter((k): k is ApiKey => typeof obj(k)?.AccessToken === 'string');
  };

  try {
    const policy = obj(obj(session?.User)?.Policy);
    if (policy?.IsAdministrator !== true) throw new MediaSetupError('not_admin');
    // 3. create the key; Jellyfin answers 204 without it, so 4. find it: a FriendFlix key that was not there before, the newest by
    // DateCreated (comparing with the list before the call, not with this backend's clock, which may differ from Jellyfin's)
    const before = new Set((await listKeys()).map((k) => k.AccessToken));
    const created = await call('POST', `/Auth/Keys?app=${APP_NAME}`, { token });
    cancel(created);
    if (created.status === 401 || created.status === 403) throw new MediaSetupError('not_admin');
    if (!created.ok) throw new MediaSetupError('unexpected');
    const when = (k: ApiKey) => (typeof k.DateCreated === 'string' ? Date.parse(k.DateCreated) || 0 : 0);
    // the key exists now: a failed listing is tried once more (still with the admin session), since without it the key cannot be found
    // and so not be revoked either
    const after = await listKeys().catch((e: unknown) => {
      if (e instanceof MediaSetupError && e.code === 'not_admin') throw e;
      return listKeys();
    });
    const fresh = after.filter((k) => k.AppName === APP_NAME && !before.has(k.AccessToken)).sort((a, b) => when(b) - when(a));
    if (!fresh[0]) throw new MediaSetupError('unexpected');
    return { JELLYFIN_URL: input.url, JELLYFIN_ADMIN_API_KEY: fresh[0].AccessToken };
  } finally {
    // 5. end the administrator's session (best effort: the key does not depend on it)
    await call('POST', '/Sessions/Logout', { token }).then(cancel, () => undefined);
  }
}

export const jellyfinSetup: MediaSetupProvider = {
  kind: 'jellyfin',
  keys: ['JELLYFIN_URL', 'JELLYFIN_ADMIN_API_KEY'],
  urlKey: 'JELLYFIN_URL',
  // GET /Auth/Keys lists the API keys: only an administrator's key may (2xx), 401/403 otherwise
  async probe(values, { fetchImpl }) {
    const { JELLYFIN_URL: url, JELLYFIN_ADMIN_API_KEY: key } = values;
    if (!url || !key) return fail('invalid', 'incomplete');
    const base = httpUrl(url);
    if (!base) return fail('invalid', 'invalid_url');
    const headers = { Authorization: mediaBrowserHeader({ deviceId: 'portal-probe', token: key }) };
    return byStatus(await fetchImpl(join(base, '/Auth/Keys'), { headers }), 'not_admin');
  },
  auto: {
    fields: ['url', 'username', 'password'],
    run: createApiKey,
    // the key deletes itself (verified on Jellyfin 12.2.0: DELETE /Auth/Keys/<key> with that key answers 204); the admin session is gone by now
    async revoke(values, { fetchImpl }) {
      const base = plainHttpUrl(values.JELLYFIN_URL ?? '');
      const key = values.JELLYFIN_ADMIN_API_KEY;
      if (!base || !key) return;
      const headers = { Authorization: mediaBrowserHeader({ device: 'Setup', deviceId: `ff-setup-${randomBytes(8).toString('hex')}`, token: key }) };
      await fetchImpl(join(base, `/Auth/Keys/${encodeURIComponent(key)}`), { method: 'DELETE', headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) })
        .then(cancel, () => undefined);
    },
  },
};
