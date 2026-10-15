// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface RemoteConfigOptions {
  backendUrl: string;
  internalSecret: string;
  /** the adapter's urlEnv (JELLYFIN_URL): set and non-empty, it wins and nothing is fetched */
  envUrl?: string;
  fetchImpl?: typeof fetch;
  /** refresh interval after a good answer (default 30 s) */
  refreshMs?: number;
  /** retry interval after a failed or refused fetch (default 5 s) */
  retryMs?: number;
  /** status lines (never values beyond the upstream's origin); default console.log */
  log?: (msg: string) => void;
}

export interface RemoteConfig {
  /** the media server base URL, or null while the backend has none (setup not done, backend unreachable since start) */
  url(): string | null;
  /** the settings revision of an /internal/authz* answer (x-ff-config-rev): one that differs from the cached one refetches at once */
  noteRev(rev: string | null): void;
  stop(): void;
}

/** a usable upstream: an absolute http(s) URL */
function usable(v: unknown): v is string {
  if (typeof v !== 'string' || !v) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The gateway's media upstream from the backend's live settings (GET /internal/gateway-config): fetched at start, retried every retryMs
 * until it answers, then refreshed every refreshMs and at once when an authz answer carries a different settings revision (also a lower
 * one: a database restored from an older backup). An answer below that revision (a backend instance that has not reloaded yet) gets one
 * more try after retryMs. One fetch at a time; a failed refresh keeps the last good URL. Only the URL's origin is ever logged (no
 * userinfo, path or query), never the secret.
 */
export function createRemoteConfig(opts: RemoteConfigOptions): RemoteConfig {
  if (opts.envUrl) {
    const fixed = opts.envUrl;
    if (!usable(fixed)) throw new Error('gateway: the media server URL from the environment is not an http(s) URL'); // never echo it (userinfo)
    return { url: () => fixed, noteRev: () => {}, stop: () => {} };
  }
  const f = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((m: string) => console.log(m));
  const refreshMs = opts.refreshMs ?? 30_000;
  const retryMs = opts.retryMs ?? 5_000;
  const endpoint = new URL('/internal/gateway-config', opts.backendUrl);

  let url: string | null = null;
  let rev: number | null = null;
  let noted: number | null = null; // the last authz rev that triggered a fetch: each different rev triggers one, never more
  let retried: number | null = null; // the noted rev that already had its one early retry
  let running = false;
  let again = false;
  let stopped = false;
  let failing = '';
  let timer: NodeJS.Timeout | undefined;
  const ac = new AbortController();

  const schedule = (ms: number) => {
    clearTimeout(timer);
    if (!stopped) (timer = setTimeout(kick, ms)).unref();
  };

  /** one fetch; true = a usable answer was taken over */
  async function fetchOnce(): Promise<boolean> {
    let why = 'unreachable';
    try {
      const r = await f(endpoint, {
        headers: { 'x-internal-secret': opts.internalSecret },
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(5000)]),
      });
      why = `HTTP ${r.status}`;
      if (!r.ok) void r.body?.cancel().catch(() => {}); // release the connection now, not at GC (retries run every retryMs)
      if (r.ok) {
        why = 'an invalid answer';
        const j = (await r.json()) as { rev?: unknown; upstreamUrl?: unknown };
        if (stopped) return false;
        if (Number.isSafeInteger(j.rev) && usable(j.upstreamUrl)) {
          if (j.upstreamUrl !== url) log(`gateway upstream: ${new URL(j.upstreamUrl).origin} (settings rev ${String(j.rev)})`);
          url = j.upstreamUrl;
          rev = j.rev as number;
          failing = '';
          return true;
        }
      }
    } catch {
      // network error, timeout or a body that is not JSON: `why` says how far it got
    }
    if (!stopped && why !== failing) {
      // once per kind of failure, not every retry
      log(`gateway config: backend ${why}; ${url ? 'keeping the last upstream' : '/media answers 503 until the media server is set up'}`);
      failing = why;
    }
    return false;
  }

  function kick(): void {
    if (stopped) return;
    if (running) {
      again = true; // the fetch in flight may predate the change: run once more after it
      return;
    }
    clearTimeout(timer);
    running = true;
    void fetchOnce().then((ok) => {
      running = false;
      if (again) {
        again = false;
        return kick();
      }
      // an instance behind the noted rev answered (several backends, one not reloaded yet): one more try soon, then the normal refresh
      const behind = ok && noted !== null && rev !== null && rev < noted && retried !== noted;
      if (behind) retried = noted;
      schedule(ok && !behind ? refreshMs : retryMs);
    });
  }

  kick();
  return {
    url: () => url,
    noteRev(v) {
      if (!v || !/^\d{1,15}$/.test(v)) return;
      const n = Number(v);
      if (n === rev || n === noted) return;
      noted = n;
      kick();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      ac.abort();
    },
  };
}
