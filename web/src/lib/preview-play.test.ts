// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Preview playback against a fake /api/items/<id>/trailer and a <video> double.
let answer: { status: number; json?: unknown };
let ls: Map<string, string>;
class FakeVideo {
  src = '';
  muted = false;
  playCalls: boolean[] = [];
  /** autoplay policy: refuse un-muted playback */
  blockSound = false;
  failAlways = false;
  async play() {
    this.playCalls.push(this.muted);
    if (this.failAlways || (this.blockSound && !this.muted)) throw new DOMException('not allowed', 'NotAllowedError');
  }
}
type Mod = typeof import('./preview');
let P: Mod;

beforeEach(async () => {
  vi.useFakeTimers();
  answer = { status: 200, json: { url: '/api/items/a/preview.mp4' } };
  ls = new Map();
  vi.stubGlobal('localStorage', { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v), removeItem: (k: string) => void ls.delete(k) });
  vi.stubGlobal('location', { pathname: '/', href: '/' });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(answer.json === undefined ? null : JSON.stringify(answer.json), { status: answer.status })));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.resetModules();
  P = await import('./preview');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const play = async (id: string, v: FakeVideo | undefined, owner?: string, explicit?: boolean) => {
  const p = P.playPreview(id, () => v as unknown as HTMLVideoElement, owner, explicit);
  await vi.advanceTimersByTimeAsync(1);
  return p;
};

describe('playPreview', () => {
  it('plays the clip muted by default and claims the preview slot', async () => {
    const v = new FakeVideo();
    expect(await play('a', v)).toBe(true);
    expect(v.src).toBe('/api/items/a/preview.mp4');
    expect(v.playCalls).toEqual([true]);
    expect(get(P.previewOwner)).toBe('a');
  });

  it('with sound on it plays un-muted, and falls back to muted when the browser refuses sound', async () => {
    P.toggleSound();
    expect(get(P.previewSound)).toBe(true);
    expect(ls.get('ff_sound')).toBe('1'); // remembered in this browser
    const v = new FakeVideo();
    v.blockSound = true;
    expect(await play('a', v)).toBe(true);
    expect(v.playCalls).toEqual([false, true]);
    expect(v.muted).toBe(true);
  });

  it('a title without preview (404) is never asked again during this visit', async () => {
    answer = { status: 404, json: { error: 'no_preview' } };
    expect(await play('a', new FakeVideo())).toBe(false);
    expect(P.previewFailed('a')).toBe(true);
    expect(get(P.previewOwner)).toBe('');
    expect(await play('a', new FakeVideo())).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled(); // 404 is normal, not worth a warning
  });

  it('an answer without url and a refused muted playback also count as failed', async () => {
    answer = { status: 200, json: null };
    expect(await play('b', new FakeVideo())).toBe(false);
    expect(P.previewFailed('b')).toBe(true);
    answer = { status: 200, json: { url: '/x.mp4' } };
    const v = new FakeVideo();
    v.failAlways = true;
    expect(await play('c', v)).toBe(false);
    expect(P.previewFailed('c')).toBe(true);
    expect(console.warn).toHaveBeenCalled();
  });

  it('gives up quietly when the <video> is not rendered, without marking the title failed', async () => {
    expect(await play('a', undefined)).toBe(false);
    expect(P.previewFailed('a')).toBe(false);
    expect(get(P.previewOwner)).toBe('');
  });

  it('a newer preview takes over: the older one does not start and is not marked failed', async () => {
    const v = new FakeVideo();
    const first = P.playPreview('a', () => v as unknown as HTMLVideoElement, 'hero:a');
    P.previewOwner.set('card-b'); // the viewer hovered another card meanwhile
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toBe(false);
    expect(v.src).toBe('');
    expect(P.previewFailed('a')).toBe(false);
    expect(get(P.previewOwner)).toBe('card-b');
  });

  it('ignores missing ids', async () => {
    expect(await play('', new FakeVideo())).toBe(false);
    expect(await play('undefined', new FakeVideo())).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stopPreview only clears its own slot', () => {
    P.previewOwner.set('x');
    P.stopPreview('y');
    expect(get(P.previewOwner)).toBe('x');
    P.stopPreview('x');
    expect(get(P.previewOwner)).toBe('');
  });
});

describe('sound toggle', () => {
  it('follows the clicked video: un-mutes a muted one and the other way round', () => {
    const v = new FakeVideo();
    v.muted = true;
    P.toggleSound(v as unknown as HTMLVideoElement);
    expect(v.muted).toBe(false);
    expect(get(P.previewSound)).toBe(true);
    P.toggleSound(v as unknown as HTMLVideoElement);
    expect(v.muted).toBe(true);
    expect(ls.get('ff_sound')).toBe('0');
  });

  it('starts with the remembered choice', async () => {
    ls.set('ff_sound', '1');
    vi.resetModules();
    P = await import('./preview');
    expect(get(P.previewSound)).toBe(true);
  });
});

describe('motion and billboard holds', () => {
  it('reduced motion disables autoplay', () => {
    expect(P.autoplayAllowed()).toBe(true);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(P.motionAllowed()).toBe(false);
    vi.stubGlobal('matchMedia', () => { throw new Error('no'); });
    expect(P.motionAllowed()).toBe(true);
  });

  it('the billboard is held while any overlay is open; releasing twice counts once', () => {
    const a = P.holdBillboard();
    const b = P.holdBillboard();
    expect(get(P.billboardHeld)).toBe(true);
    a();
    a();
    expect(get(P.billboardHeld)).toBe(true);
    b();
    expect(get(P.billboardHeld)).toBe(false);
  });
});
