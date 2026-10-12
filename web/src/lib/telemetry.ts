/**
 * Browser error reporting: window 'error' / 'unhandledrejection' listeners and the SvelteKit handleError hook feed one
 * Reporter that filters noise, dedupes and rate-limits per page load before posting to /api/client-errors.
 * The filter / dedupe logic is DOM-free so it can be unit tested; only `installTelemetry` touches window.
 */

export type ReportKind = 'error' | 'unhandledrejection' | 'resource';
export interface RawReport { message: string; stack?: string; kind: ReportKind; filename?: string }
export interface Payload { message: string; stack?: string; url: string; userAgent: string; kind: ReportKind; release?: string }

export const ENDPOINT = '/api/client-errors';
export const DEDUPE_MS = 60_000;
export const MAX_REPORTS = 10;

const EXTENSION_URL = /(?:chrome|moz|safari|safari-web)-extension:\/\//i;
const RESIZE_NOISE = /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/i;

/** True for errors that are not ours: browser extensions, ResizeObserver loop warnings, opaque cross-origin "Script error.". */
export function shouldIgnore(r: Pick<RawReport, 'message' | 'stack' | 'filename'>): boolean {
  if (RESIZE_NOISE.test(r.message)) return true;
  if (r.message.trim() === 'Script error.' && !r.stack) return true; // cross-origin script without details: nothing actionable
  return EXTENSION_URL.test(r.stack ?? '') || EXTENSION_URL.test(r.filename ?? '') || EXTENSION_URL.test(r.message);
}

/** Message + stack of anything that can be thrown. */
export function describeError(e: unknown): { message: string; stack?: string } {
  if (e instanceof Error) return { message: e.message || e.name, stack: e.stack };
  if (typeof e === 'string') return { message: e };
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; stack?: unknown };
    if (typeof o.message === 'string') return { message: o.message, stack: typeof o.stack === 'string' ? o.stack : undefined };
    try { return { message: JSON.stringify(e) ?? String(e) }; } catch { /* circular */ }
  }
  return { message: String(e) };
}

export interface ReporterOpts {
  send: (r: RawReport) => void;
  now?: () => number;
  dedupeMs?: number;
  max?: number;
}

/** Decides what is sent: ignores noise, drops identical messages for `dedupeMs`, stops after `max` reports. */
export class Reporter {
  private readonly seen = new Map<string, number>();
  private sent = 0;
  private readonly send: (r: RawReport) => void;
  private readonly now: () => number;
  private readonly dedupeMs: number;
  private readonly max: number;

  constructor(o: ReporterOpts) {
    this.send = o.send;
    this.now = o.now ?? Date.now;
    this.dedupeMs = o.dedupeMs ?? DEDUPE_MS;
    this.max = o.max ?? MAX_REPORTS;
  }

  /** Returns true when the report was passed on. */
  report(r: RawReport): boolean {
    if (this.sent >= this.max || shouldIgnore(r)) return false;
    const t = this.now();
    const key = `${r.kind}\n${r.message}`;
    const last = this.seen.get(key);
    if (last !== undefined && t - last < this.dedupeMs) return false;
    for (const [k, at] of this.seen) if (t - at >= this.dedupeMs) this.seen.delete(k); // keep the map small
    this.seen.set(key, t);
    this.sent++;
    try { this.send(r); } catch { /* reporting must never throw */ }
    return true;
  }
}

export interface Env {
  url: string;
  userAgent: string;
  release?: string;
  sendBeacon?: (url: string, data: string) => boolean;
  fetch?: (url: string, init: { method: string; body: string; keepalive: boolean; headers: Record<string, string> }) => Promise<unknown>;
}

export function toPayload(r: RawReport, env: Pick<Env, 'url' | 'userAgent' | 'release'>): Payload {
  return {
    message: r.message.slice(0, 500),
    stack: r.stack ? r.stack.slice(0, 4000) : undefined,
    url: env.url.split(/[?#]/)[0]!.slice(0, 500), // path only: query strings can hold tokens and search terms
    userAgent: env.userAgent.slice(0, 300),
    kind: r.kind,
    release: env.release ? env.release.slice(0, 40) : undefined,
  };
}

/** sendBeacon (survives page unloads, text/plain => no CORS preflight, no csrf header needed), fetch keepalive as fallback. */
export function transmit(r: RawReport, env: Env): void {
  const body = JSON.stringify(toPayload(r, env));
  try { if (env.sendBeacon?.(ENDPOINT, body)) return; } catch { /* fall through */ }
  try {
    void env.fetch?.(ENDPOINT, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain;charset=UTF-8' } })?.catch?.(() => {});
  } catch { /* give up silently */ }
}

// ---- browser wiring ----------------------------------------------------------------------------------------------

interface Target {
  addEventListener(type: string, fn: (e: any) => void, capture?: boolean): void;
}
let active: Reporter | undefined;

/** Registers the window listeners once per page load (repeat calls return the same reporter). */
export function installTelemetry(opts: { release?: string; target?: Target; env?: Partial<Env>; reporter?: Reporter } = {}): Reporter {
  if (active) return active;
  const target: Target | undefined = opts.target ?? (typeof window === 'undefined' ? undefined : window);
  const env = (): Env => ({
    url: typeof location === 'undefined' ? '' : location.pathname,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    release: opts.release,
    sendBeacon: typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' ? (u, d) => navigator.sendBeacon(u, d) : undefined,
    fetch: typeof fetch === 'function' ? (u, i) => fetch(u, i) : undefined,
    ...opts.env,
  });
  const reporter = opts.reporter ?? new Reporter({ send: (r) => transmit(r, env()) });
  active = reporter;
  if (!target) return reporter;

  target.addEventListener('error', (e: ErrorEvent | Event) => {
    const el = (e as Event).target as { tagName?: string; src?: string; href?: string } | null;
    if (el && el.tagName && !(e as ErrorEvent).message) {
      // resource load failure (capture phase only): scripts and stylesheets break the app, a missing poster does not
      if (el.tagName !== 'SCRIPT' && el.tagName !== 'LINK') return;
      const src = (el.src || el.href || '').split(/[?#]/)[0];
      reporter.report({ kind: 'resource', message: `Failed to load <${el.tagName.toLowerCase()}> ${src}` });
      return;
    }
    const ev = e as ErrorEvent;
    const d = ev.error !== undefined && ev.error !== null ? describeError(ev.error) : { message: ev.message || 'Unknown error', stack: undefined };
    reporter.report({ kind: 'error', message: d.message || ev.message, stack: d.stack, filename: ev.filename });
  }, true);
  target.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    reporter.report({ kind: 'unhandledrejection', ...describeError(e.reason) });
  });
  return reporter;
}

/** For SvelteKit's handleError (errors thrown while loading / rendering never reach window.onerror). */
export function reportError(error: unknown, kind: ReportKind = 'error'): void {
  active?.report({ kind, ...describeError(error) });
}

/** Test helper: forget the installed reporter. */
export function resetTelemetryForTests(): void { active = undefined; }
