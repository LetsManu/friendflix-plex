// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The probe result and the small helpers every probe shares. A leaf module (no imports): the media setup providers (media/setup.ts,
 * jellyfin/setup.ts) use it without importing probes.ts, which imports media/index.ts (spec Part H, no import cycle).
 */
export type ProbeCode = 'ok' | 'unreachable' | 'timeout' | 'unauthorized' | 'invalid' | 'not_admin' | 'issuer_mismatch' | 'wizard_pending' | 'unexpected' | 'warning';
/** `detail` is an i18n code, never an upstream body */
export interface ProbeResult { ok: boolean; code: ProbeCode; detail?: string }

export const OK: ProbeResult = { ok: true, code: 'ok' };
export const fail = (code: ProbeCode, detail?: string): ProbeResult => ({ ok: false, code, ...(detail ? { detail } : {}) });

/** An http(s) URL, or undefined (the caller answers invalid_url). */
export function httpUrl(raw: string): URL | undefined {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : undefined;
  } catch {
    return undefined;
  }
}

/** httpUrl without user info: a URL the wizard sends one-time credentials to (`http://user:pw@host` is refused, not split). */
export function plainHttpUrl(raw: string): URL | undefined {
  const u = httpUrl(raw);
  return u && !u.username && !u.password ? u : undefined;
}

/** base + path without a double slash; the base may carry a path (a reverse-proxy prefix) */
export const join = (base: URL, path: string) => new URL(base.pathname.replace(/\/+$/, '') + path, base.origin);

/** Maps an HTTP status; 401/403 to `denied`. */
export function byCode(status: number, denied: ProbeCode = 'unauthorized'): ProbeResult {
  if (status >= 200 && status < 300) return OK;
  if (status >= 300 && status < 400) return fail('invalid', 'redirect');
  if (status === 401 || status === 403) return fail(denied);
  if (status === 404) return fail('invalid', 'not_found');
  return fail('unreachable', 'upstream_error');
}

/** byCode for an answer whose body is not needed (it is cancelled, never read). */
export function byStatus(r: Response, denied?: ProbeCode): ProbeResult {
  void r.body?.cancel().catch(() => undefined);
  return byCode(r.status, denied);
}

/** A JSON body of at most `max` bytes (a URL the admin typed may answer anything); null when larger or not JSON. */
export async function smallJson(r: Response, max = 4096): Promise<unknown> {
  const reader = r.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}
