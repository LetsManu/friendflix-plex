// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { clientAddress, isHomeAddress, isHomeRequest, isValidCidr } from '../src/netaddr.js';
import { loadConfig } from '../src/config.js';

const HOME = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '::1/128', 'fc00::/7', 'fe80::/10'];
const req = (headers: Record<string, string>, peer?: string) => ({ headers, socket: { remoteAddress: peer } });

describe('isHomeAddress', () => {
  it.each(['10.1.2.3', '192.168.0.5', '127.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.2', '::ffff:c0a8:0102', '172.31.255.1'])('%s is home', (ip) => {
    expect(isHomeAddress(ip, HOME)).toBe(true);
  });
  it.each(['8.8.8.8', '2001:db8::1', '', 'unknown', '172.32.0.1', '::ffff:8.8.8.8', '999.1.1.1', 'not-an-ip'])('%s is remote', (ip) => {
    expect(isHomeAddress(ip, HOME)).toBe(false);
  });
  it('ignores broken CIDRs and an empty list', () => {
    expect(isHomeAddress('10.0.0.1', ['garbage', '10.0.0.0/99', '10.0.0.0/8'])).toBe(true);
    expect(isHomeAddress('10.0.0.1', [])).toBe(false);
  });
});

describe('clientAddress', () => {
  it('prefers x-real-ip, then the LAST x-forwarded-for entry, then the socket peer', () => {
    expect(clientAddress(req({ 'x-real-ip': '203.0.113.1', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, '10.0.0.1'))).toBe('203.0.113.1');
    expect(clientAddress(req({ 'x-forwarded-for': '192.168.1.10, 203.0.113.9' }, '10.0.0.1'))).toBe('203.0.113.9');
    expect(clientAddress(req({}, '10.0.0.1'))).toBe('10.0.0.1');
    expect(clientAddress(req({}))).toBe('unknown');
  });
});

describe('isHomeRequest', () => {
  it('without a forwarding header only loopback is home (a docker bridge peer is remote)', () => {
    expect(isHomeRequest(req({}, '127.0.0.1'), HOME)).toBe(true);
    expect(isHomeRequest(req({}, '::1'), HOME)).toBe(true);
    expect(isHomeRequest(req({}, '172.18.0.5'), HOME)).toBe(false);
    expect(isHomeRequest(req({}, '192.168.1.5'), HOME)).toBe(false);
  });
  it('with a forwarding header the derived address decides', () => {
    expect(isHomeRequest(req({ 'x-real-ip': '192.168.1.10' }, '203.0.113.1'), HOME)).toBe(true);
    expect(isHomeRequest(req({ 'x-forwarded-for': '192.168.1.10, 203.0.113.9' }, '127.0.0.1'), HOME)).toBe(false);
  });
});

describe('unusable forwarding headers', () => {
  it('a header without a usable value is the no-header case: loopback only', () => {
    expect(isHomeRequest(req({ 'x-forwarded-for': ',' }, '192.168.1.5'), HOME)).toBe(false);
    expect(isHomeRequest(req({ 'x-forwarded-for': ' , ' }, '172.18.0.5'), HOME)).toBe(false);
    expect(isHomeRequest(req({ 'x-real-ip': '  ' }, '10.0.0.7'), HOME)).toBe(false);
    expect(isHomeRequest(req({ 'x-forwarded-for': ',' }, '127.0.0.1'), HOME)).toBe(true);
  });
});

describe('HOME_NETWORKS config', () => {
  const BASE = {
    PUBLIC_URL: 'https://p.example.com', DATABASE_URL: 'x', REDIS_URL: 'x', APP_ENC_KEY: 'k'.repeat(44), INTERNAL_SECRET: 'i'.repeat(20), OIDC_ISSUER: 'https://a.example.com',
    OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', JELLYFIN_URL: 'http://j', JELLYFIN_ADMIN_API_KEY: 'k', REQUESTS_URL: 'http://s', REQUESTS_API_KEY: 'k', WEBHOOK_SECRET: 'w'.repeat(20),
  };
  it('defaults to RFC1918 + loopback + ULA + link-local', () => {
    expect(loadConfig(BASE).HOME_NETWORKS).toEqual(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '::1/128', 'fc00::/7', 'fe80::/10']);
  });
  it('accepts a custom list and fails at startup on an invalid entry', () => {
    expect(loadConfig({ ...BASE, HOME_NETWORKS: ' 203.0.113.0/24 , 2001:db8::/32 ' }).HOME_NETWORKS).toEqual(['203.0.113.0/24', '2001:db8::/32']);
    expect(() => loadConfig({ ...BASE, HOME_NETWORKS: '10.0.0.0/8,192.168.0.0/33' })).toThrow(/HOME_NETWORKS: invalid CIDR '192\.168\.0\.0\/33'/);
    expect(() => loadConfig({ ...BASE, HOME_NETWORKS: 'lan' })).toThrow(/invalid CIDR 'lan'/);
  });
  it('HEALTH_DISK_WARN_PCT at or above HEALTH_DISK_CRIT_PCT falls back to 85 / 95 with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(loadConfig({ ...BASE, HEALTH_DISK_WARN_PCT: '90', HEALTH_DISK_CRIT_PCT: '80' })).toMatchObject({ HEALTH_DISK_WARN_PCT: 85, HEALTH_DISK_CRIT_PCT: 95 });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/HEALTH_DISK_WARN_PCT \(90\) must be below HEALTH_DISK_CRIT_PCT \(80\)/));
      expect(loadConfig({ ...BASE, HEALTH_DISK_WARN_PCT: '70', HEALTH_DISK_CRIT_PCT: '90' })).toMatchObject({ HEALTH_DISK_WARN_PCT: 70, HEALTH_DISK_CRIT_PCT: 90 });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
  it('isValidCidr', () => {
    for (const c of ['10.0.0.0/8', '1.2.3.4', 'fc00::/7', '::1/128']) expect(isValidCidr(c)).toBe(true);
    for (const c of ['10.0.0.0/33', 'fc00::/129', '10.0.0.0/8/1', 'x', '', '10.0.0.0/-1']) expect(isValidCidr(c)).toBe(false);
  });
});
