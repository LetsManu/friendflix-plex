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
}
