export class SeerrError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type PortalStatus = 'nicht_angefragt' | 'angefragt' | 'in_arbeit' | 'teilweise' | 'verfuegbar' | 'abgelehnt';

/** Seerr media status: 1 unknown, 2 pending, 3 processing, 4 partially available, 5 available. Request status: 1 pending, 2 approved, 3 declined. */
export function portalStatus(mediaStatus?: number, requestStatus?: number): PortalStatus {
  if (requestStatus === 3 && mediaStatus !== 5) return 'abgelehnt';
  if (mediaStatus === 5) return 'verfuegbar';
  if (mediaStatus === 4) return 'teilweise';
  if (mediaStatus === 3 || requestStatus === 2) return 'in_arbeit';
  if (mediaStatus === 2 || requestStatus === 1) return 'angefragt';
  return 'nicht_angefragt';
}

export type RequestStateKey = 'pending' | 'approved' | 'processing' | 'available' | 'partial' | 'declined' | 'unknown';

/** Language-neutral state of one Seerr request (admin UI translates it): declined > available > partial > processing > approved > pending. */
export function requestStateKey(mediaStatus?: number, requestStatus?: number): RequestStateKey {
  if (requestStatus === 3 && mediaStatus !== 5) return 'declined';
  if (mediaStatus === 5) return 'available';
  if (mediaStatus === 4) return 'partial';
  if (mediaStatus === 3) return 'processing';
  if (requestStatus === 2) return 'approved';
  if (mediaStatus === 2 || requestStatus === 1) return 'pending';
  return 'unknown';
}

/** Seerr REST client (API key only used here, server-side; Seerr is reachable only on the internal network). */
export class SeerrClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string) {
    return `${this.baseUrl.replace(/\/$/, '')}/api/v1${path}`;
  }

  async json<T = any>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(this.url(path), {
      ...init,
      headers: { 'X-Api-Key': this.apiKey, 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new SeerrError(res.status, `Seerr ${init.method ?? 'GET'} ${path.split('?')[0]} -> ${res.status}`);
    const t = await res.text();
    return (t ? JSON.parse(t) : undefined) as T;
  }

  search(query: string, page = 1) {
    // Seerr requires %20 (not +) for spaces
    return this.json<{ results: any[]; totalPages: number }>(`/search?query=${encodeURIComponent(query)}&page=${page}&language=de`);
  }
  upcoming(mediaType: 'movie' | 'tv', page = 1) {
    return this.json<{ results: any[]; totalPages: number }>(`/discover/${mediaType === 'movie' ? 'movies' : 'tv'}/upcoming?page=${page}&language=de`);
  }
  details(mediaType: 'movie' | 'tv', id: number) {
    return this.json(`/${mediaType}/${id}?language=de`);
  }
  createRequest(body: { mediaType: 'movie' | 'tv'; mediaId: number; seasons?: number[] | 'all'; userId?: number }) {
    return this.json('/request', { method: 'POST', body: JSON.stringify(body) });
  }
  getRequest(id: number) {
    return this.json(`/request/${id}`);
  }
  listRequests(filter: string, take = 50, skip = 0) {
    return this.json<{ results: any[]; pageInfo: any }>(`/request?take=${take}&skip=${skip}&filter=${encodeURIComponent(filter)}&sort=added`);
  }
  /** request totals by state (Seerr /request/count) */
  requestCount() {
    return this.json<{ total: number; movie: number; tv: number; pending: number; approved: number; declined: number; processing: number; available: number }>('/request/count');
  }
  approve(id: number) {
    return this.json(`/request/${id}/approve`, { method: 'POST' });
  }
  decline(id: number) {
    return this.json(`/request/${id}/decline`, { method: 'POST' });
  }
  listUsers() {
    return this.json<{ results: Array<{ id: number; jellyfinUserId?: string; email?: string }> }>('/user?take=200&skip=0');
  }
  importJellyfinUsers(jellyfinUserIds: string[]) {
    return this.json<Array<{ id: number; jellyfinUserId?: string }>>('/user/import-from-jellyfin', { method: 'POST', body: JSON.stringify({ jellyfinUserIds }) });
  }
  // ---- local Seerr users (media servers without a Seerr user import, capabilities.requestUsers = 'local') ----
  /** One user; a SeerrError with status 404 when it does not exist (any more). */
  getUser(id: number) {
    return this.json<{ id: number; email?: string }>(`/user/${id}`);
  }
  /** One page of users (oldest first), for the lookup by email. */
  listUsersPage(take: number, skip: number) {
    return this.json<{ results: Array<{ id: number; email?: string }>; pageInfo?: { results?: number } }>(`/user?take=${take}&skip=${skip}&sort=created`);
  }
  /**
   * Creates a local user (needs an API key with MANAGE_USERS, i.e. the admin key). Seerr gives it its *default* permissions; 409 when
   * the email is taken. The password is required unless Seerr's email agent is on (it would mail one); FriendFlix never uses it.
   */
  createLocalUser(body: { email: string; username: string; password: string }) {
    return this.json<{ id: number }>('/user', { method: 'POST', body: JSON.stringify(body) });
  }
  /** Sets a user's permission bits (PUT /user/{id} replaces username + permissions, so the username is sent along). */
  setUserPermissions(id: number, username: string, permissions: number) {
    return this.json(`/user/${id}`, { method: 'PUT', body: JSON.stringify({ username, permissions }) });
  }
  deleteUser(id: number) {
    return this.json(`/user/${id}`, { method: 'DELETE' });
  }
}
