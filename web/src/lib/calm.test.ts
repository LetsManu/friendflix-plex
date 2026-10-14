// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();
vi.mock('#lib/api', () => ({ api: (...a: unknown[]) => api(...a), ApiError: class extends Error { status = 0; } }));
const { prefs, DEFAULT_PREFS } = await import('./stores');
const { autoplayAllowed, calmMode, motionAllowed, playPreview, previewOwner } = await import('./preview');

beforeEach(() => { api.mockReset(); prefs.set({ ...DEFAULT_PREFS }); previewOwner.set(''); });

describe('calm mode helper', () => {
  it('is off by default and follows the profile pref', () => {
    expect(DEFAULT_PREFS.calm).toBe(false);
    expect(calmMode()).toBe(false);
    prefs.set({ ...DEFAULT_PREFS, calm: true });
    expect(calmMode()).toBe(true);
    expect(motionAllowed()).toBe(false);
    expect(autoplayAllowed()).toBe(false);
  });
  it('playPreview never starts (and never asks the server) in calm mode, unless the viewer explicitly asked', async () => {
    prefs.set({ ...DEFAULT_PREFS, calm: true });
    expect(await playPreview('abc', () => undefined)).toBe(false);
    expect(api).not.toHaveBeenCalled();
    expect(get(previewOwner)).toBe('');
    api.mockResolvedValue({}); // explicit: goes on to fetch the clip (none here -> fails quietly)
    expect(await playPreview('abc', () => undefined, 'abc', true)).toBe(false);
    expect(api).toHaveBeenCalledWith('/api/items/abc/trailer');
  });
  it('without calm mode the preview request is made', async () => {
    api.mockResolvedValue({});
    await playPreview('def', () => undefined);
    expect(api).toHaveBeenCalledWith('/api/items/def/trailer');
  });
  it('html.calm is toggled with the pref', () => {
    const cls = new Set<string>();
    const el = { classList: { toggle: (c: string, on: boolean) => (on ? cls.add(c) : cls.delete(c)) } };
    vi.stubGlobal('document', { documentElement: el, getElementById: () => ({}), head: { append: () => undefined } });
    prefs.set({ ...DEFAULT_PREFS, calm: true });
    expect(cls.has('calm')).toBe(true);
    prefs.set({ ...DEFAULT_PREFS, calm: false });
    expect(cls.has('calm')).toBe(false);
    vi.unstubAllGlobals();
  });
});
