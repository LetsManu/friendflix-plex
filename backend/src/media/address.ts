// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fork: a media server address that is only an address. Plex's own "View XML" links carry the token as `?X-Plex-Token=…`; pasted into
 * PLEX_URL it would be stored unencrypted (PLEX_URL is no secret), shown in Admin -> Settings and sent to the gateway. So PLEX_URL must
 * be http(s) without userinfo, query or fragment (the setting's schema, the probe and the wizard refuse it as `invalid_url`; an env pin
 * with one stops the start with "PLEX_URL is invalid (invalid_url)"), and whatever shows or passes it on uses origin + path only.
 * No imports: config.ts (via media/index.ts), plex/setup.ts and the routes all use it.
 */

/** http(s), no user:pass@, no query and no fragment (also not an empty `?` or `#`) */
export function isBareHttpUrl(raw: string): boolean {
  if (/[?#]/.test(raw)) return false;
  try {
    const u = new URL(raw);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** a bare URL as is, any other one as origin + path (never its userinfo, query or fragment); '' when it does not parse (never echoed) */
export function addressOnly(raw: string): string {
  if (isBareHttpUrl(raw)) return raw;
  try {
    const u = new URL(raw);
    return u.origin === 'null' ? '' : u.origin + u.pathname;
  } catch {
    return '';
  }
}
