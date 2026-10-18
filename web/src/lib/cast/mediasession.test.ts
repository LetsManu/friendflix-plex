// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { writable } from 'svelte/store';
import { describe, expect, it, vi } from 'vitest';
import type { CastSession } from './engine';
import { bindCastMediaSession, type MediaSessionLike } from './mediasession';

const view = (over: Partial<CastSession> = {}): CastSession => ({
  kind: 'chromecast', device: 'Wohnzimmer-TV', itemId: 'ep1', seriesId: 's1', title: 'Bright Valley', subtitle: 'S1:E1 First', posterId: 'ep1', isEpisode: true,
  position: 60, duration: 1800, paused: false, buffering: false, state: 'playing', audioTracks: [], subtitles: [], subIndex: -1, ...over,
});
function fake() {
  const handlers = new Map<string, ((d: { seekTime?: number; seekOffset?: number }) => void) | null>();
  const ms: MediaSessionLike & { pos: unknown[] } = {
    metadata: undefined, playbackState: 'none', pos: [],
    setActionHandler: (a, fn) => { handlers.set(a, fn); },
    setPositionState(s) { this.pos.push(s); },
  };
  const eng = { playPause: vi.fn(), seek: vi.fn(), skip: vi.fn(), next: vi.fn(async () => undefined) };
  return { ms, handlers, eng };
}

describe('cast media session (lock screen / Control Center drive the TV)', () => {
  it('metadata, state, position and actions follow the cast session; they are cleared without one', () => {
    const { ms, handlers, eng } = fake();
    const s = writable<CastSession | null>(null);
    const off = bindCastMediaSession(s, eng, ms, (m) => m);
    expect(handlers.size).toBe(0);
    s.set(view());
    expect(ms.metadata).toEqual({ title: 'S1:E1 First', artist: 'Bright Valley', artwork: [{ src: '/media/Items/ep1/Images/Primary?maxWidth=512&quality=85', sizes: '512x512' }] });
    expect(ms.playbackState).toBe('playing');
    expect(ms.pos.at(-1)).toEqual({ duration: 1800, position: 60, playbackRate: 1 });
    handlers.get('pause')!({});
    handlers.get('play')!({}); // already playing: no toggle
    expect(eng.playPause).toHaveBeenCalledTimes(1);
    handlers.get('seekto')!({ seekTime: 300 });
    expect(eng.seek).toHaveBeenCalledWith(300);
    handlers.get('seekbackward')!({});
    handlers.get('seekforward')!({ seekOffset: 30 });
    expect(eng.skip.mock.calls).toEqual([[-10], [30]]);
    handlers.get('nexttrack')!({});
    expect(eng.next).toHaveBeenCalledTimes(1);
    s.set(view({ paused: true }));
    expect(ms.playbackState).toBe('paused');
    handlers.get('play')!({});
    expect(eng.playPause).toHaveBeenCalledTimes(2);
    // a film: no next-episode action, film title only
    s.set(view({ itemId: 'f', title: 'Film', subtitle: '', isEpisode: false, posterId: 'f' }));
    expect(handlers.get('nexttrack')).toBeNull();
    expect(ms.metadata).toMatchObject({ title: 'Film', artist: 'Wohnzimmer-TV' });
    s.set(null);
    expect([...handlers.values()].every((h) => h === null)).toBe(true);
    expect(ms.metadata).toBeNull();
    expect(ms.playbackState).toBe('none');
    off();
  });

  it('is a no-op without the Media Session API', () => {
    expect(() => bindCastMediaSession(writable(view()), fake().eng, undefined)()).not.toThrow();
  });
});
