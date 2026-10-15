// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MediaSetupProvider } from '../media/setup.js';
import { byCode, fail, join, plainHttpUrl, smallJson, type ProbeResult } from '../settings/probeKit.js';
import { PLEX_CLIENT_HEADERS } from './client.js';

/**
 * FriendFlix for Plex: the media setup provider (setup wizard step 3 and the Admin -> Settings `media` probe). Manual only: the admin
 * enters the server address and a token, there is no `auto` (a plex.tv password sign-in would send the password to a third host and
 * leave an unrevocable account token; a PIN-link flow is a follow-up). Reached only through media/setup.ts; imports nothing of
 * media/index.ts at runtime (spec Part H, no import cycle).
 *
 * The probe, in order:
 *   1. GET /identity without the token (PMS answers it unauthenticated): is this a Plex server at all (machineIdentifier)?
 *   2. GET /library/sections with the token: does PMS accept it? 401/403 -> unauthorized (a hard failure).
 *   3. GET /status/sessions with the token: an admin (owner) token may, a shared account's token may not. Refused -> a WARNING
 *      (ok: true, detail not_admin): docs/plex.md allows a dedicated account; the save goes through, the admin sees the note.
 * The token goes only into the X-Plex-Token header, never into a URL or query, a log line or a result (a result is a code only). Every
 * request has a 5 s deadline and never follows a redirect: a 3xx is refused (invalid/redirect), so the token reaches only the host
 * that was typed in.
 */
const TIMEOUT_MS = 5_000;

const isTimeout = (e: unknown) => {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
};
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const cancel = (r: Response) => void r.body?.cancel().catch(() => undefined);

async function probe(values: Record<string, string | undefined>, { fetchImpl }: { fetchImpl: typeof fetch }): Promise<ProbeResult> {
  const { PLEX_URL: url, PLEX_TOKEN: token } = values;
  if (!url || !token) return fail('invalid', 'incomplete');
  const base = plainHttpUrl(url);
  if (!base) return fail('invalid', 'invalid_url');

  const get = (path: string, withToken: boolean) => fetchImpl(join(base, path), {
    headers: { Accept: 'application/json', ...PLEX_CLIENT_HEADERS, 'X-Plex-Client-Identifier': 'friendflix-probe', ...(withToken ? { 'X-Plex-Token': token } : {}) },
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  try {
    // 1. a Plex server answers /identity with its machineIdentifier (another service: 404 or another body)
    const id = await get('/identity', false);
    if (id.status < 200 || id.status >= 300) {
      cancel(id);
      return byCode(id.status);
    }
    const machine = obj(obj(await smallJson(id))?.MediaContainer)?.machineIdentifier;
    if (typeof machine !== 'string' || !machine) return fail('invalid', 'bad_response');

    // 2. the token: PMS accepts it for the libraries
    const sections = await get('/library/sections', true);
    cancel(sections);
    if (sections.status === 401 || sections.status === 403) return fail('unauthorized');
    if (sections.status < 200 || sections.status >= 300) return byCode(sections.status);

    // 3. admin rights: only the server owner (admin) token sees the sessions; a shared account's token is a warning, not a refusal
    const sessions = await get('/status/sessions', true);
    cancel(sessions);
    if (sessions.status === 401 || sessions.status === 403) return { ok: true, code: 'warning', detail: 'not_admin' };
    return byCode(sessions.status);
  } catch (e) {
    // a network error or a body that breaks: a code only, never the error text (it could quote the request)
    return fail(isTimeout(e) ? 'timeout' : 'unreachable');
  }
}

export const plexSetup: MediaSetupProvider = {
  kind: 'plex',
  keys: ['PLEX_URL', 'PLEX_TOKEN'],
  urlKey: 'PLEX_URL',
  probe,
};
