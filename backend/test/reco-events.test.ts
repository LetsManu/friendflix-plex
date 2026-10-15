// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry } from '../src/metrics.js';
import { makeEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let s: { cookies: Record<string, string>; csrf: string };
const post = (payload: unknown, auth = true) =>
  env.app.inject({ method: 'POST', url: '/api/reco/events', ...(auth ? { cookies: s.cookies, headers: { 'x-csrf-token': s.csrf } } : {}), payload: payload as object });
const value = async (name: string, row: string, engine: string) => {
  const m = (await registry.getMetricsAsJSON()).find((x) => x.name === name);
  return m?.values.find((v) => v.labels.row === row && v.labels.engine === engine)?.value ?? 0;
};

beforeAll(async () => {
  env = await makeEnv();
  s = await env.login();
});
afterAll(() => env.close());

describe('POST /api/reco/events', () => {
  it('counts impressions, clicks and dismisses per row and engine', async () => {
    const i0 = await value('friendflix_reco_impressions_total', 'because', 'v1');
    const c0 = await value('friendflix_reco_clicks_total', 'because', 'v1');
    const d0 = await value('friendflix_reco_dismiss_total', 'popular', 'v2');
    const r = await post({ events: [{ row: 'because', engine: 'v1', impressions: 2, clicks: 1 }, { row: 'popular', engine: 'v2', dismisses: 3 }] });
    expect(r.statusCode).toBe(204);
    expect(await value('friendflix_reco_impressions_total', 'because', 'v1')).toBe(i0 + 2);
    expect(await value('friendflix_reco_clicks_total', 'because', 'v1')).toBe(c0 + 1);
    expect(await value('friendflix_reco_dismiss_total', 'popular', 'v2')).toBe(d0 + 3);
  });
  it('rejects unknown rows and engines (bounded labels) and oversized counts', async () => {
    expect((await post({ events: [{ row: 'Dune: Part Two', engine: 'v1', impressions: 1 }] })).statusCode).toBe(400);
    expect((await post({ events: [{ row: 'because', engine: 'secret-engine', impressions: 1 }] })).statusCode).toBe(400);
    expect((await post({ events: [{ row: 'because', engine: 'v1', clicks: 5000 }] })).statusCode).toBe(400);
    expect((await post({ events: [] })).statusCode).toBe(400);
    const text = await registry.metrics();
    expect(text).not.toContain('Dune');
    expect(text).not.toContain('secret-engine');
  });
  it('needs a session and the CSRF token', async () => {
    expect((await post({ events: [{ row: 'because', engine: 'v1', impressions: 1 }] }, false)).statusCode).toBe(401);
    const r = await env.app.inject({ method: 'POST', url: '/api/reco/events', cookies: s.cookies, payload: { events: [{ row: 'because', engine: 'v1', impressions: 1 }] } });
    expect(r.statusCode).toBe(403);
  });
});
