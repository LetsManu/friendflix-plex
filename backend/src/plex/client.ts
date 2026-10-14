// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MediaError } from '../media/types.js';
import { timed } from '../timing.js';

/** Plex HTTP failure; routes only look at the server-neutral MediaError base class. Messages never contain the token or a query. */
export class PlexError extends MediaError {}

/** Identification headers PMS insists on (the universal transcoder answers 400 without Platform/Product). */
export const PLEX_CLIENT_HEADERS = {
  'X-Plex-Product': 'FriendFlix',
  'X-Plex-Platform': 'Chrome',
  'X-Plex-Device': 'Web',
  'X-Plex-Version': '1',
} as const;

/** `MediaContainer` of a Plex JSON answer (fields we read; everything else stays `unknown`). */
export interface PlexContainer {
  size?: number;
  totalSize?: number;
  offset?: number;
  Metadata?: Array<Record<string, any>>;
  Directory?: Array<Record<string, any>>;
  Hub?: Array<Record<string, any>>;
  [k: string]: unknown;
}

/**
 * Low-level Plex Media Server client with the ONE admin token (PLEX_TOKEN). Backend-only: the token goes into the
 * X-Plex-Token request header and never into a URL, a log line, an error message or anything a client sees.
 */
export class PlexClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    readonly fetchImpl: typeof fetch = fetch,
    /** X-Plex-Client-Identifier of the backend's own (non-playback) requests */
    readonly clientId = 'friendflix-backend',
  ) {}

  /** Server-relative path (+ query) -> absolute URL. Anything else (absolute or protocol-relative URL, backslashes, control chars) is refused. */
  url(path: string): string {
    if (!/^\/(?![/\\])/.test(path) || path.includes('\\') || /[\x00-\x1f]/.test(path)) throw new PlexError(400, 'Plex: only server-relative paths');
    const base = new URL(this.baseUrl.replace(/\/?$/, '/'));
    const u = new URL(path.replace(/^\//, ''), base);
    if (u.origin !== base.origin) throw new PlexError(400, 'Plex: only server-relative paths');
    return u.toString();
  }

  /** Request headers incl. the token (backend -> PMS only). */
  headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Accept: 'application/json', ...PLEX_CLIENT_HEADERS, 'X-Plex-Client-Identifier': this.clientId, ...extra, 'X-Plex-Token': this.token };
  }

  /** Every Plex request goes through here (booked as the media server (`jf`) in the request's Server-Timing). */
  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = this.url(path);
    return timed('jf', () => this.fetchImpl(url, {
      ...init,
      headers: this.headers(init.headers as Record<string, string> | undefined),
      signal: init.signal ?? AbortSignal.timeout(20_000),
    }));
  }

  /** JSON body of a successful answer (empty body -> undefined); non-2xx -> PlexError with the status. */
  async json<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetch(path, init);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new PlexError(res.status, `Plex ${init.method ?? 'GET'} ${path.split('?')[0]} -> ${res.status}`);
    }
    const t = await res.text();
    try {
      return (t ? JSON.parse(t) : undefined) as T;
    } catch {
      throw new PlexError(502, `Plex ${path.split('?')[0]}: no JSON`);
    }
  }

  /** `MediaContainer` of a JSON answer ({} when absent). */
  async container(path: string, init: RequestInit = {}): Promise<PlexContainer> {
    const j = await this.json<{ MediaContainer?: PlexContainer }>(path, init);
    return j?.MediaContainer ?? {};
  }

  /**
   * All `Metadata` of a listing, paged with X-Plex-Container-Start/-Size (totalSize is only reported when paging is requested).
   * Stops at a short page or after `max` entries.
   */
  async *paged(path: string, pageSize = 500, max = 1_000_000): AsyncGenerator<Array<Record<string, any>>> {
    const sep = path.includes('?') ? '&' : '?';
    for (let start = 0; start < max; start += pageSize) {
      const c = await this.container(`${path}${sep}X-Plex-Container-Start=${start}&X-Plex-Container-Size=${pageSize}`);
      const page = c.Metadata ?? [];
      if (page.length) yield page;
      const total = typeof c.totalSize === 'number' ? c.totalSize : undefined;
      if (page.length < pageSize || (total !== undefined && start + page.length >= total)) return;
    }
  }

  async sections(): Promise<Array<Record<string, any>>> {
    return (await this.container('/library/sections')).Directory ?? [];
  }

  /** `GET /identity` answers without a token; with a token it also proves the token is accepted (401 otherwise). */
  async ping(): Promise<boolean> {
    try {
      const res = await this.fetch('/identity', { signal: AbortSignal.timeout(3000) });
      await res.body?.cancel().catch(() => undefined);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** ws(s) URL of the notification websocket. Carries the token as query: backend -> PMS only, never logged. */
  websocketUrl(): string {
    const u = new URL(this.url('/:/websockets/notifications'));
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('X-Plex-Token', this.token);
    return u.toString();
  }
}
