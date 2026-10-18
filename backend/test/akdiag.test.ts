// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AkUpstreamError, akLogFields, deniedClass, endpointOf, fetchFailClass, lastAkFailures, noteAkFailure } from '../src/akdiag.js';
import { MemoryKV } from '../src/kv.js';

// The Authentik failure classes the status card and the log show: class, status and endpoint path, never a host, query, id or token.
describe('akdiag', () => {
  it('endpointOf keeps only the API path: no host prefix, no query, no ids', () => {
    expect(endpointOf('/auth/api/v3/core/users/12/?search=anna%40example.com')).toBe('api/v3/core/users/:id/');
    expect(endpointOf('/api/v3/flows/executor/default-authentication-flow/?query=flow_token%3Dsecret')).toBe('api/v3/flows/executor/default-authentication-flow/');
    expect(endpointOf('api/v3/core/users/?page=2')).toBe('api/v3/core/users/');
  });

  it('classifies refusals and fetch failures', () => {
    expect(deniedClass(401, undefined)).toBe('token_invalid');
    expect(deniedClass(403, 'Token invalid/expired')).toBe('token_invalid');
    expect(deniedClass(403, 'You do not have permission to perform this action.')).toBe('permission');
    expect(fetchFailClass(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(fetchFailClass(new TypeError('fetch failed'))).toBe('network');
  });

  it('keeps the latest failure per area for the status card; log fields only for upstream errors', async () => {
    const ctx = { kv: new MemoryKV() };
    await noteAkFailure(ctx, { area: 'api', cls: 'permission', status: 403, endpoint: 'api/v3/core/users/' });
    await noteAkFailure(ctx, { area: 'api', cls: 'token_invalid', status: 403, endpoint: 'api/v3/core/users/' });
    await noteAkFailure(ctx, { area: 'executor', cls: 'non_json', status: 200, endpoint: 'api/v3/flows/executor/x/' });
    const seen = await lastAkFailures(ctx);
    expect(seen.map((f) => `${f.area}:${f.cls}`)).toEqual(['executor:non_json', 'api:token_invalid']);
    expect(seen.every((f) => typeof f.at === 'string')).toBe(true);
    await ctx.kv.set('akdiag:last:api', '{broken', 60);
    expect((await lastAkFailures(ctx)).map((f) => f.area)).toEqual(['executor']);
    const err = new AkUpstreamError(502, 'authentik_error', { area: 'executor', cls: 'redirect', status: 301, endpoint: 'api/v3/flows/executor/x/' });
    expect(akLogFields(err)).toEqual({ area: 'executor', cls: 'redirect', status: 301, endpoint: 'api/v3/flows/executor/x/' });
    expect(akLogFields(new Error('x'))).toEqual({});
  });
});
