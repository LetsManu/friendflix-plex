import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEDUPE_MS, MAX_REPORTS, Reporter, describeError, installTelemetry, reportError, resetTelemetryForTests, shouldIgnore, toPayload, transmit, type RawReport } from './telemetry';

const err = (message: string, kind: RawReport['kind'] = 'error', extra: Partial<RawReport> = {}): RawReport => ({ message, kind, ...extra });

describe('shouldIgnore', () => {
  it('drops errors from browser extensions (stack, filename or message)', () => {
    expect(shouldIgnore({ message: 'x', stack: 'Error: x\n    at chrome-extension://abc/content.js:1:1' })).toBe(true);
    expect(shouldIgnore({ message: 'x', stack: 'at moz-extension://uuid/inject.js:3:4' })).toBe(true);
    expect(shouldIgnore({ message: 'x', filename: 'safari-web-extension://id/a.js' })).toBe(true);
    expect(shouldIgnore({ message: 'Failed to fetch chrome-extension://id/x.js' })).toBe(true);
  });
  it('drops ResizeObserver loop noise', () => {
    expect(shouldIgnore({ message: 'ResizeObserver loop limit exceeded' })).toBe(true);
    expect(shouldIgnore({ message: 'ResizeObserver loop completed with undelivered notifications.' })).toBe(true);
  });
  it('drops opaque cross-origin "Script error." but keeps it when a stack exists', () => {
    expect(shouldIgnore({ message: 'Script error.' })).toBe(true);
    expect(shouldIgnore({ message: 'Script error.', stack: 'at https://x/a.js:1:1' })).toBe(false);
  });
  it('keeps our own errors', () => {
    expect(shouldIgnore({ message: "Cannot read properties of undefined (reading 'name')", stack: 'at https://portal/_app/immutable/chunks/a.js:1:2' })).toBe(false);
  });
});

describe('Reporter', () => {
  let t = 0;
  let sent: RawReport[];
  let r: Reporter;
  beforeEach(() => { t = 1_000; sent = []; r = new Reporter({ send: (x) => sent.push(x), now: () => t }); });

  it('passes a report on once', () => {
    expect(r.report(err('boom'))).toBe(true);
    expect(sent).toHaveLength(1);
  });
  it('dedupes identical messages for 60 s, then allows them again', () => {
    expect(r.report(err('boom'))).toBe(true);
    t += DEDUPE_MS - 1;
    expect(r.report(err('boom'))).toBe(false);
    t += 1;
    expect(r.report(err('boom'))).toBe(true);
    expect(sent).toHaveLength(2);
  });
  it('treats a different message or a different kind as a different error', () => {
    expect(r.report(err('boom'))).toBe(true);
    expect(r.report(err('bang'))).toBe(true);
    expect(r.report(err('boom', 'unhandledrejection'))).toBe(true);
    expect(sent).toHaveLength(3);
  });
  it('sends at most 10 reports per page load', () => {
    for (let i = 0; i < 25; i++) r.report(err('e' + i));
    expect(sent).toHaveLength(MAX_REPORTS);
    t += 10 * DEDUPE_MS;
    expect(r.report(err('later'))).toBe(false);
  });
  it('deduped and ignored reports do not use up the budget', () => {
    for (let i = 0; i < 50; i++) r.report(err('same'));
    for (let i = 0; i < 50; i++) r.report(err('x', 'error', { stack: 'at chrome-extension://a/b.js' }));
    for (let i = 0; i < 9; i++) expect(r.report(err('other' + i))).toBe(true);
    expect(sent).toHaveLength(10);
  });
  it('ignores extension errors and ResizeObserver noise', () => {
    expect(r.report(err('x', 'error', { stack: 'at moz-extension://a/b.js:1:1' }))).toBe(false);
    expect(r.report(err('ResizeObserver loop limit exceeded'))).toBe(false);
    expect(sent).toHaveLength(0);
  });
  it('never throws when the sender does', () => {
    const bad = new Reporter({ send: () => { throw new Error('offline'); } });
    expect(() => bad.report(err('boom'))).not.toThrow();
  });
});

describe('describeError', () => {
  it('handles errors, strings, objects and primitives', () => {
    expect(describeError(new TypeError('nope')).message).toBe('nope');
    expect(describeError(new TypeError('nope')).stack).toContain('TypeError');
    expect(describeError('plain')).toEqual({ message: 'plain' });
    expect(describeError({ message: 'm', stack: 's' })).toEqual({ message: 'm', stack: 's' });
    expect(describeError({ a: 1 }).message).toBe('{"a":1}');
    expect(describeError(undefined).message).toBe('undefined');
    expect(describeError(null).message).toBe('null');
  });
});

describe('toPayload / transmit', () => {
  const env = { url: '/search?q=secret#x', userAgent: 'UA', release: '1700000000000' };
  it('sends the path only and respects the backend limits', () => {
    const p = toPayload(err('m'.repeat(900), 'error', { stack: 's'.repeat(9000) }), { ...env, userAgent: 'u'.repeat(900), release: 'r'.repeat(90) });
    expect(p.url).toBe('/search');
    expect(p.message).toHaveLength(500);
    expect(p.stack).toHaveLength(4000);
    expect(p.userAgent).toHaveLength(300);
    expect(p.release).toHaveLength(40);
    expect(toPayload(err('x'), { ...env, url: 'https://h/a/b?token=1' }).url).toBe('https://h/a/b');
  });
  it('uses sendBeacon with a text/plain JSON string', () => {
    const sendBeacon = vi.fn(() => true);
    const fetch = vi.fn();
    transmit(err('boom'), { ...env, sendBeacon, fetch });
    expect(sendBeacon).toHaveBeenCalledOnce();
    const [url, data] = sendBeacon.mock.calls[0] as unknown as [string, string];
    expect(url).toBe('/api/client-errors');
    expect(JSON.parse(data)).toMatchObject({ message: 'boom', kind: 'error', url: '/search', userAgent: 'UA' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('falls back to fetch keepalive when sendBeacon is missing, refuses or throws', async () => {
    for (const sendBeacon of [undefined, () => false, () => { throw new Error('x'); }]) {
      const fetch = vi.fn(async () => ({}));
      transmit(err('boom'), { ...env, sendBeacon, fetch });
      expect(fetch).toHaveBeenCalledOnce();
      const init = (fetch.mock.calls[0] as unknown as [string, { method: string; keepalive: boolean; headers: Record<string, string>; body: string }])[1];
      expect(init).toMatchObject({ method: 'POST', keepalive: true, headers: { 'content-type': 'text/plain;charset=UTF-8' } });
      expect(JSON.parse(init.body).message).toBe('boom');
    }
  });
  it('swallows a rejected fallback fetch', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('offline')));
    expect(() => transmit(err('boom'), { ...env, fetch })).not.toThrow();
    await Promise.resolve();
  });
});

describe('installTelemetry', () => {
  beforeEach(() => resetTelemetryForTests());
  const fakeTarget = () => {
    const h: Record<string, Array<(e: any) => void>> = {};
    return { h, addEventListener: (t: string, f: (e: any) => void) => { (h[t] ??= []).push(f); } };
  };

  it('registers the listeners once, however often it is called', () => {
    const target = fakeTarget();
    const a = installTelemetry({ target, env: { sendBeacon: () => true } });
    const b = installTelemetry({ target, env: { sendBeacon: () => true } });
    expect(b).toBe(a);
    expect(target.h.error).toHaveLength(1);
    expect(target.h.unhandledrejection).toHaveLength(1);
  });

  it('reports window errors, rejections and failed scripts; ignores failed images', () => {
    const target = fakeTarget();
    const beacons: any[] = [];
    installTelemetry({ target, release: 'r1', env: { url: '/p?x=1', userAgent: 'UA', sendBeacon: (_u, d) => (beacons.push(JSON.parse(d)), true) } });
    target.h.error![0]!({ message: 'Uncaught TypeError: x', error: new TypeError('x'), filename: 'https://p/a.js' });
    target.h.unhandledrejection![0]!({ reason: new Error('rejected') });
    target.h.error![0]!({ target: { tagName: 'SCRIPT', src: 'https://p/_app/a.js?v=1' } });
    target.h.error![0]!({ target: { tagName: 'IMG', src: 'https://p/media/x.png' } });
    expect(beacons.map((b) => [b.kind, b.message, b.url, b.release])).toEqual([
      ['error', 'x', '/p', 'r1'],
      ['unhandledrejection', 'rejected', '/p', 'r1'],
      ['resource', 'Failed to load <script> https://p/_app/a.js', '/p', 'r1'],
    ]);
  });

  it('ignores extension errors coming through window', () => {
    const target = fakeTarget();
    const beacon = vi.fn(() => true);
    installTelemetry({ target, env: { sendBeacon: beacon } });
    target.h.error![0]!({ message: 'x', error: Object.assign(new Error('x'), { stack: 'Error: x\n at chrome-extension://a/c.js:1:1' }) });
    target.h.error![0]!({ message: 'ResizeObserver loop limit exceeded' });
    expect(beacon).not.toHaveBeenCalled();
  });

  it('reportError (handleError hook) goes through the same dedupe', () => {
    const target = fakeTarget();
    const beacon = vi.fn(() => true);
    installTelemetry({ target, env: { sendBeacon: beacon } });
    reportError(new Error('load failed'));
    reportError(new Error('load failed'));
    expect(beacon).toHaveBeenCalledOnce();
  });

  it('reportError before installation is a no-op', () => {
    expect(() => reportError(new Error('early'))).not.toThrow();
  });
});
