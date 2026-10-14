// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Route = (method: string, body: unknown) => { status?: number; json?: unknown } | Promise<{ status?: number; json?: unknown }>;
let routes: Record<string, Route>;
let calls: string[];
type Mod = typeof import('./reminders');
let R: Mod;

beforeEach(async () => {
  routes = {};
  calls = [];
  vi.stubGlobal('location', { pathname: '/', href: '/' });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push(`${method} ${path}`);
    const r = await (routes[`${method} ${path}`] ?? (() => ({ status: 404, json: { error: 'not_found' } })))(method, init.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status ?? 200 });
  }));
  vi.resetModules();
  R = await import('./reminders');
});
afterEach(() => vi.unstubAllGlobals());

describe('keys', () => {
  it('builds movie/show and episode keys', () => {
    expect(R.movieKey('movie', 603)).toBe('movie:603');
    expect(R.episodeKey('abc')).toBe('ep:abc');
  });
});

describe('loadReminders', () => {
  it('loads once and caches; force reloads', async () => {
    routes['GET /api/reminders/keys'] = () => ({ json: { keys: { 'movie:603': 5 } } });
    await R.loadReminders();
    await R.loadReminders();
    expect(get(R.remindKeys)).toEqual({ 'movie:603': 5 });
    expect(calls).toEqual(['GET /api/reminders/keys']);
    routes['GET /api/reminders/keys'] = () => ({ json: {} });
    await R.loadReminders(true);
    expect(get(R.remindKeys)).toEqual({});
  });

  it('a failed load is retried on the next call', async () => {
    routes['GET /api/reminders/keys'] = () => ({ status: 500 });
    await R.loadReminders();
    routes['GET /api/reminders/keys'] = () => ({ json: { keys: { 'tv:1': 1 } } });
    await R.loadReminders();
    expect(get(R.remindKeys)).toEqual({ 'tv:1': 1 });
    expect(calls).toHaveLength(2);
  });
});

describe('toggleReminder', () => {
  it('turns a reminder on optimistically and stores the server id', async () => {
    let seen: Record<string, number> | null = null;
    routes['POST /api/reminders'] = (_m, body) => { seen = get(R.remindKeys); expect(body).toEqual({ mediaType: 'movie', tmdbId: 603 }); return { json: { id: 42 } }; };
    expect(await R.toggleReminder('movie:603', { mediaType: 'movie', tmdbId: 603 })).toBe('on');
    expect(seen).toEqual({ 'movie:603': 0 }); // visible while the request runs
    expect(get(R.remindKeys)).toEqual({ 'movie:603': 42 });
  });

  it('turns an existing reminder off; a 404 (already gone) also counts as off', async () => {
    R.remindKeys.set({ 'ep:x': 7, 'ep:y': 8 });
    routes['DELETE /api/reminders/7'] = () => ({ status: 204 });
    expect(await R.toggleReminder('ep:x', { episodeId: 'x' })).toBe('off');
    expect(get(R.remindKeys)).toEqual({ 'ep:y': 8 });
    expect(await R.toggleReminder('ep:y', { episodeId: 'y' })).toBe('off'); // DELETE 8 answers 404
    expect(get(R.remindKeys)).toEqual({});
  });

  it('rolls back on failure; 409 means the title is already available', async () => {
    R.remindKeys.set({ 'ep:x': 7 });
    routes['DELETE /api/reminders/7'] = () => ({ status: 500 });
    expect(await R.toggleReminder('ep:x', { episodeId: 'x' })).toBe('error');
    expect(get(R.remindKeys)).toEqual({ 'ep:x': 7 });
    routes['POST /api/reminders'] = () => ({ status: 409, json: { error: 'already_available' } });
    expect(await R.toggleReminder('movie:1', { mediaType: 'movie', tmdbId: 1 })).toBe('available');
    routes['POST /api/reminders'] = () => ({ status: 500 });
    expect(await R.toggleReminder('movie:1', { mediaType: 'movie', tmdbId: 1 })).toBe('error');
    expect(get(R.remindKeys)).toEqual({ 'ep:x': 7 });
  });

  it('a second toggle of the same key while one runs is refused as busy', async () => {
    let release!: () => void;
    routes['POST /api/reminders'] = () => new Promise((r) => { release = () => r({ json: { id: 1 } }); });
    const first = R.toggleReminder('tv:9', { mediaType: 'tv', tmdbId: 9 });
    expect(await R.toggleReminder('tv:9', { mediaType: 'tv', tmdbId: 9 })).toBe('busy');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    expect(await first).toBe('on');
  });
});

describe('removeReminder', () => {
  it('deletes on the server, then drops the key', async () => {
    R.remindKeys.set({ 'movie:1': 3 });
    routes['DELETE /api/reminders/3'] = () => ({ status: 204 });
    await R.removeReminder('movie:1', 3);
    expect(get(R.remindKeys)).toEqual({});
  });

  it('keeps the key when the server refuses', async () => {
    R.remindKeys.set({ 'movie:1': 3 });
    routes['DELETE /api/reminders/3'] = () => ({ status: 500 });
    await expect(R.removeReminder('movie:1', 3)).rejects.toThrow();
    expect(get(R.remindKeys)).toEqual({ 'movie:1': 3 });
  });
});
