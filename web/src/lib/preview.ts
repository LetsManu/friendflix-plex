import { derived, get, writable } from 'svelte/store';
import { api, ApiError } from '#lib/api';
import { prefs } from '#lib/stores';

/**
 * Calm mode (profile pref `calm`): the ONE helper every autoplaying thing asks. No billboard trailer, hover-card preview, detail
 * auto-start preview or other background video, and no sound with them; animations are damped by the `html.calm` rule (stores.ts).
 * `prefers-reduced-motion` counts as calm for motion, so `motionAllowed()` is the check for anything that moves on its own.
 */
export const calmMode = (): boolean => get(prefs).calm === true;
export function motionAllowed(): boolean {
  if (calmMode()) return false;
  try { return typeof matchMedia === 'undefined' || !matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return true; }
}
/** May a preview / trailer clip start by itself (no click)? Calm mode and reduced motion say no. */
export const autoplayAllowed = (): boolean => motionAllowed();

/** Owner of the preview that is running right now (a card's item id, or `hero:<id>`) - only one at a time. */
export const previewOwner = writable<string>('');
/** Titles whose preview failed (or that have none) during this page visit: never retried, so hovering one again cannot start a new Jellyfin session every second. */
const failed = new Set<string>();
export const previewFailed = (itemId: string) => failed.has(itemId);

/** Sound for previews (hover cards + billboard). Remembered per browser once the viewer turns it on; muted by default. */
const KEY = 'ff_sound';
let saved: string | null = null;
try { saved = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null; } catch { /* blocked storage */ }
export const previewSound = writable<boolean>(saved === '1');
previewSound.subscribe((on) => { try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private mode */ } });

/**
 * Turns sound on/off. Called from a click, so the browser allows un-muting even when autoplay had to start muted.
 */
export function toggleSound(v?: HTMLVideoElement) {
  const turnOn = v ? v.muted : !get(previewSound);
  previewSound.set(turnOn);
  if (v) v.muted = !turnOn;
}

/**
 * Plays the muted-or-not preview of `itemId` in the <video> returned by `getVideo`.
 * `owner` identifies who plays it (defaults to the item id) so the billboard and the hover cards never play together.
 * `explicit`: the viewer asked for it (button click) - the only case that plays in calm mode.
 */
export async function playPreview(itemId: string, getVideo: () => HTMLVideoElement | undefined, owner = itemId, explicit = false): Promise<boolean> {
  if (!itemId || itemId === 'undefined' || failed.has(itemId)) return false;
  // calm mode: nothing starts by itself; only a click on "Trailer abspielen" (explicit) may still play
  if (!explicit && calmMode()) return false;
  previewOwner.set(owner); // claim synchronously so the card's guard keeps the <video> mounted
  try {
    const { url } = (await api<{ url?: string } | null>(`/api/items/${itemId}/trailer`)) ?? {};
    if (!url || typeof url !== 'string') throw new ApiError(404, { error: 'no_preview' });
    await new Promise((r) => setTimeout(r, 0)); // wait for the <video> to render
    const v = getVideo();
    if (!v) { console.warn('[preview] <video> not rendered for', itemId); stopPreview(owner); return false; }
    if (get(previewOwner) !== owner) return false; // somebody else took over while we were loading
    v.src = url; // pre-generated plain MP4 (no hls.js, no transcode on hover)
    // sound as chosen; browsers only allow it after the visitor has interacted with the page, otherwise fall back to muted
    v.muted = !get(previewSound);
    try { await v.play(); } catch (e) {
      if (v.muted) throw e;
      v.muted = true;
      await v.play();
    }
    return true;
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) console.warn('[preview] failed', itemId, e); // 404 = this title simply has no preview
    if (get(previewOwner) === owner) failed.add(itemId); // not when we were merely superseded by another preview
    stopPreview(owner);
    return false;
  }
}

export function stopPreview(owner: string) {
  previewOwner.update((o) => (o === owner ? '' : o));
}

/**
 * Overlays that cover the billboard (ItemModal, preview/action sheets) hold it paused while they are open:
 * `const release = holdBillboard()` on open, `release()` on close (idempotent). `billboardHeld` is true while any hold exists.
 */
const holds = writable(0);
export const billboardHeld = derived(holds, (n) => n > 0);
export function holdBillboard(): () => void {
  let done = false;
  holds.update((n) => n + 1);
  return () => { if (done) return; done = true; holds.update((n) => Math.max(0, n - 1)); };
}
