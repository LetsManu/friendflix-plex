// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A fake Authentik flow executor for the akflow tests (and the flow route tests built on it), shaped after the exchanges recorded
 * from Authentik 2026.8.3 (fixtures/akflow/exchange-login.json):
 * - the first executor call sets `authentik_session`;
 * - a valid answer is a real 302 to the executor itself (optionally twice), an invalid one a 200 with `response_errors`;
 * - after the last stage the executor answers `xak-flow-redirect {to:'/', final_redirect:true}`;
 * - a logged-in session (after the last stage) also gets `authentik_csrf`; the invalidation flow deletes `authentik_session`
 *   with `Max-Age=0`.
 * Stages are a stateful list per fake. Every call is recorded with its lower-cased headers.
 */
import { readFileSync } from 'node:fs';
import type { RawChallenge } from '../src/akflow.js';

/** AUTHENTIK_URL in the tests: another origin than the browser-facing issuer (https://auth.example.com) */
export const AK_URL = 'http://auth.example.com:9000';

/** a recorded challenge from fixtures/akflow/<name>.json */
export function fixture(name: string): RawChallenge {
  return JSON.parse(readFileSync(new URL(`./fixtures/akflow/${name}.json`, import.meta.url), 'utf8')) as RawChallenge;
}

export interface AkCall { method: string; url: URL; path: string; search: string; headers: Record<string, string>; body?: any }

export interface FakeStage {
  /** what the executor shows while this stage is current */
  challenge: RawChallenge;
  /** checks an answer: true advances, a challenge (with response_errors) is answered with 200 and stays on this stage */
  answer?: (body: any, call: AkCall) => true | RawChallenge;
  /** 302 hops after a valid answer (default 1: POST → 302 → GET → 200; 2 as recorded for the last stage) */
  hops?: number;
  /** extra Set-Cookie lines sent with the answer's first redirect */
  setCookie?: string[];
}

export interface FakeAuthentik {
  fetch: typeof fetch;
  calls: AkCall[];
  /** index of the current stage (stages.length = the flow ended) */
  state: { index: number };
  /** replaces the fetch answer for one call (network errors, CSRF failure pages ...) */
  override?: (call: AkCall) => Response | Promise<Response | undefined> | undefined;
}

const json = (body: unknown, setCookie: string[] = [], status = 200) => {
  const h = new Headers({ 'content-type': 'application/json' });
  for (const c of setCookie) h.append('set-cookie', c);
  return new Response(JSON.stringify(body), { status, headers: h });
};
const redirect = (to: string, setCookie: string[] = []) => {
  const h = new Headers({ location: to, 'content-type': 'text/html; charset=utf-8' });
  for (const c of setCookie) h.append('set-cookie', c);
  return new Response(null, { status: 302, headers: h });
};

export const FINAL: RawChallenge = { component: 'xak-flow-redirect', to: '/', final_redirect: true };

/** A fake executor walking through `stages`; any other path answers 404 unless `routes` has it ("METHOD /path" → handler). */
export function fakeAuthentik(stages: FakeStage[], routes: Record<string, (call: AkCall) => Response | Promise<Response>> = {}): FakeAuthentik {
  const fake: FakeAuthentik = { calls: [], state: { index: 0 }, fetch: undefined as unknown as typeof fetch };
  let session = 0;
  let pendingHops = 0;
  fake.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const method = (init.method ?? 'GET').toUpperCase();
    const call: AkCall = { method, url, path: url.pathname, search: url.search, headers, body: init.body ? JSON.parse(String(init.body)) : undefined };
    fake.calls.push(call);
    const over = await fake.override?.(call);
    if (over) return over;
    const route = routes[`${method} ${url.pathname}`];
    if (route) return route(call);
    const m = /^\/api\/v3\/flows\/executor\/([^/]+)\/$/.exec(url.pathname);
    if (!m) return new Response('<html>not found</html>', { status: 404, headers: { 'content-type': 'text/html' } });
    const cookies = headers.cookie ?? '';
    const fresh = !/authentik_session=/.test(cookies) ? [`authentik_session=s${++session}; HttpOnly; Path=/; SameSite=Lax`] : [];
    const self = `${url.pathname}${url.search}`;
    if (pendingHops > 0) {
      pendingHops--;
      return redirect(self, fresh);
    }
    const stage = stages[fake.state.index];
    if (!stage) {
      const login = /authentik_csrf=/.test(cookies) ? [] : ['authentik_csrf=c1; expires=Thu, 14 Oct 2027 07:11:37 GMT; Max-Age=31449600; Path=/; SameSite=Lax'];
      return json(FINAL, [...fresh, ...login]);
    }
    if (method === 'GET') return json(stage.challenge, fresh);
    const verdict = stage.answer ? stage.answer(call.body, call) : true;
    if (verdict !== true) return json(verdict, fresh);
    fake.state.index++;
    pendingHops = (stage.hops ?? 1) - 1;
    return redirect(self, [...fresh, ...(stage.setCookie ?? [])]);
  }) as typeof fetch;
  return fake;
}
