// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Media Session for the cast session: the lock screen / Control Center / notification shows what plays on the TV and its
 * buttons drive the TV (play, pause, seek, ±10 s, next episode) through the cast engine. Without a session the handlers and
 * the metadata are cleared again (the page's own media, if any, gets the browser's defaults back).
 */
import type { Readable } from 'svelte/store';
import { img } from '#lib/api';
import type { CastEngine, CastSession } from './engine';

type Eng = Pick<CastEngine, 'playPause' | 'seek' | 'skip' | 'next'>;
/** the part of `navigator.mediaSession` used here (tests pass a fake) */
export interface MediaSessionLike {
  metadata: unknown;
  playbackState: 'none' | 'paused' | 'playing';
  setActionHandler(action: string, fn: ((d: { seekTime?: number; seekOffset?: number }) => void) | null): void;
  setPositionState?(s: { duration: number; position: number; playbackRate: number }): void;
}
export const CAST_ACTIONS = ['play', 'pause', 'seekto', 'seekbackward', 'seekforward', 'nexttrack'] as const;

export function bindCastMediaSession(
  session: Readable<CastSession | null>, eng: Eng,
  ms: MediaSessionLike | undefined = typeof navigator !== 'undefined' ? (navigator.mediaSession as unknown as MediaSessionLike | undefined) : undefined,
  meta: (m: { title: string; artist: string; artwork: Array<{ src: string; sizes: string }> }) => unknown = (m) => new MediaMetadata(m),
): () => void {
  if (!ms) return () => undefined;
  let bound = false, lastKey = '';
  const set = (a: string, fn: ((d: { seekTime?: number; seekOffset?: number }) => void) | null) => { try { ms.setActionHandler(a, fn); } catch { /* action not supported here */ } };
  const clear = () => {
    if (!bound) return;
    bound = false; lastKey = '';
    for (const a of CAST_ACTIONS) set(a, null);
    ms.metadata = null;
    ms.playbackState = 'none';
  };
  let cur: CastSession | null = null;
  const off = session.subscribe((s) => {
    cur = s;
    if (!s) { clear(); return; }
    if (!bound) {
      bound = true;
      set('play', () => { if (cur?.paused) eng.playPause(); });
      set('pause', () => { if (cur && !cur.paused) eng.playPause(); });
      set('seekto', (d) => { if (typeof d.seekTime === 'number') eng.seek(d.seekTime); });
      set('seekbackward', (d) => eng.skip(-(d.seekOffset || 10)));
      set('seekforward', (d) => eng.skip(d.seekOffset || 10));
    }
    // the next-episode button only for episodes (the engine's next(): the offered one, else the one after)
    const key = `${s.itemId}|${s.title}|${s.subtitle}|${s.isEpisode}`;
    if (key !== lastKey) {
      lastKey = key;
      set('nexttrack', s.isEpisode ? () => void eng.next() : null);
      try { ms.metadata = meta({ title: s.subtitle || s.title, artist: s.subtitle ? s.title : s.device, artwork: [{ src: img(s.posterId, 512), sizes: '512x512' }] }); } catch { /* no MediaMetadata */ }
    }
    ms.playbackState = s.state === 'playing' && !s.paused ? 'playing' : 'paused';
    if (s.duration > 0) { try { ms.setPositionState?.({ duration: s.duration, position: Math.min(s.duration, Math.max(0, s.position)), playbackRate: 1 }); } catch { /* invalid state */ } }
  });
  return () => { off(); clear(); };
}
