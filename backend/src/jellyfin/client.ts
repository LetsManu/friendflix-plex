// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { MediaError } from '../media/types.js';
import type { RoleTemplate } from '../roles.js';
import { timed } from '../timing.js';

/**
 * Jellyfin authorization header, e.g.
 * MediaBrowser Client="FriendFlix", Device="Portal", DeviceId="abc", Version="0.1.0", Token="..."
 * Values are stripped of quotes/newlines so they can never break out of the header.
 */
export function mediaBrowserHeader(opts: { deviceId: string; token?: string; version?: string }): string {
  const esc = (v: string) => v.replace(/["\\\r\n]/g, '');
  const parts: Array<[string, string]> = [
    ['Client', 'FriendFlix'],
    ['Device', 'Portal'],
    ['DeviceId', opts.deviceId],
    ['Version', opts.version ?? '0.1.0'],
  ];
  if (opts.token) parts.push(['Token', opts.token]);
  return 'MediaBrowser ' + parts.map(([k, v]) => `${k}="${esc(v)}"`).join(', ');
}

export interface AuthResult {
  AccessToken: string;
  User: { Id: string; Name: string };
}

/** Jellyfin HTTP failure; routes only check the server-neutral MediaError base class. */
export class JellyfinError extends MediaError {}

/** Maps a role template to the Jellyfin UserPolicy fields we manage. */
export function policyFromTemplate(t: RoleTemplate, folderIds: string[] | null): Record<string, unknown> {
  return {
    IsAdministrator: false,
    IsDisabled: false,
    EnableRemoteAccess: true,
    EnableAllFolders: t.libraries === 'all',
    EnabledFolders: t.libraries === 'all' ? [] : (folderIds ?? []),
    MaxParentalRating: t.maxParentalRating,
    EnableVideoPlaybackTranscoding: t.transcoding,
    EnableAudioPlaybackTranscoding: t.transcoding,
    EnablePlaybackRemuxing: true,
    EnableContentDownloading: t.download,
    EnableMediaConversion: false,
    EnableLiveTvAccess: false,
    EnableSharedDeviceControl: false,
    RemoteClientBitrateLimit: t.maxBitrate,
    MaxActiveSessions: t.maxStreams,
  };
}

/** Low-level Jellyfin client: admin-key calls plus raw user-token calls. Never used by browsers. */
export class JellyfinClient {
  constructor(
    readonly baseUrl: string,
    private readonly adminApiKey: string,
    readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Server-relative path (+ query) -> absolute URL. Anything else (absolute or protocol-relative URL, backslashes) is refused. */
  url(path: string) {
    if (!/^\/(?![/\\])/.test(path) || path.includes('\\') || /[\x00-\x1f]/.test(path)) throw new JellyfinError(400, 'Jellyfin: only server-relative paths');
    const base = new URL(this.baseUrl.replace(/\/?$/, '/'));
    const u = new URL(path.replace(/^\//, ''), base);
    if (u.origin !== base.origin) throw new JellyfinError(400, 'Jellyfin: only server-relative paths');
    return u.toString();
  }

  private adminHeaders() {
    return {
      Authorization: mediaBrowserHeader({ deviceId: 'portal-admin', token: this.adminApiKey }),
      'content-type': 'application/json',
    };
  }

  /** Every Jellyfin request goes through here: booked as `jf` in the request's Server-Timing (time to response headers). */
  private send(url: string, init: RequestInit) {
    return timed('jf', () => this.fetchImpl(url, init));
  }

  adminFetch(path: string, init: RequestInit = {}) {
    return this.send(this.url(path), {
      ...init,
      headers: { ...this.adminHeaders(), ...(init.headers as Record<string, string> | undefined) },
      signal: init.signal ?? AbortSignal.timeout(15000),
    });
  }

  async adminJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.adminFetch(path, init);
    if (!res.ok) throw new JellyfinError(res.status, `Jellyfin ${init.method ?? 'GET'} ${path} -> ${res.status}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  userFetch(token: string, deviceId: string, path: string, init: RequestInit = {}) {
    return this.send(this.url(path), {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
        Authorization: mediaBrowserHeader({ deviceId, token }),
      },
      signal: init.signal ?? AbortSignal.timeout(20000),
    });
  }

  async authenticateByName(username: string, password: string, deviceId: string = randomUUID()): Promise<AuthResult> {
    const res = await this.send(this.url('/Users/AuthenticateByName'), {
      method: 'POST',
      headers: { Authorization: mediaBrowserHeader({ deviceId }), 'content-type': 'application/json' },
      body: JSON.stringify({ Username: username, Pw: password }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new JellyfinError(res.status, `Jellyfin auth failed: ${res.status}`);
    return (await res.json()) as AuthResult;
  }

  createUser(name: string, password: string) {
    return this.adminJson<{ Id: string }>('/Users/New', { method: 'POST', body: JSON.stringify({ Name: name, Password: password }) });
  }

  async deleteUser(id: string) {
    await this.adminFetch(`/Users/${id}`, { method: 'DELETE' });
  }

  async setPassword(id: string, newPw: string) {
    // Admin reset then set: Jellyfin accepts NewPw with ResetPassword=false when called as admin.
    await this.adminJson(`/Users/${id}/Password`, { method: 'POST', body: JSON.stringify({ NewPw: newPw }) });
  }

  /** Merges our managed policy fields into the existing policy (keeps unknown fields intact). */
  async setPolicy(userId: string, patch: Record<string, unknown>) {
    const user = await this.adminJson<{ Policy: Record<string, unknown> }>(`/Users/${userId}`);
    await this.adminJson(`/Users/${userId}/Policy`, { method: 'POST', body: JSON.stringify({ ...user.Policy, ...patch }) });
  }

  async mediaFolders(): Promise<Array<{ Id: string; Name: string }>> {
    const r = await this.adminJson<{ Items: Array<{ Id: string; Name: string }> }>('/Library/MediaFolders');
    return r.Items;
  }

  sessions() {
    return this.adminJson<Array<Record<string, any>>>('/Sessions?activeWithinSeconds=15');
  }

  /** Block 22: every recently active session (FriendFlix devices included), for the admin's active streams */
  allSessions() {
    return this.adminJson<Array<Record<string, any>>>('/Sessions?activeWithinSeconds=30');
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(this.url('/System/Ping'), { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
