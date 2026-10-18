// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { writable } from 'svelte/store';
import { api, getActiveProfile } from '#lib/api';
import { syncBadge } from '#lib/badge';
import { getLocale, locale, remountPage, setLocale, tr, type Locale } from '#lib/i18n';

/** Ids on "Merkliste" (watchlist). Loaded once, updated optimistically by cards and detail pages. */
export const listIds = writable<Set<string>>(new Set());

export async function loadList() {
  try {
    listIds.set(new Set((await api('/api/watchlist/ids')).ids));
  } catch {
    /* non-fatal */
  }
}

const listBusy = new Set<string>();
/**
 * Message callers show (role="status") when saving "Merkliste" / a favourite failed. A live binding that follows the
 * UI language (read it when the message is shown); components may also use `$t('account.listSaveFailed')` directly.
 */
export let SAVE_FAILED = tr('account.listSaveFailed');
locale.subscribe(() => { SAVE_FAILED = tr('account.listSaveFailed'); });

/**
 * Adds/removes an item on "Merkliste" optimistically. `on` is the current state (true = remove).
 * Resolves true when saved, false when it failed (state is rolled back). A second call for the same
 * id while one is in flight is ignored and resolves true (nothing to report).
 */
export async function toggleList(id: string, on: boolean): Promise<boolean> {
  if (listBusy.has(id)) return true;
  listBusy.add(id);
  const set = (present: boolean) => listIds.update((s) => {
    const n = new Set(s);
    if (present) n.add(id); else n.delete(id);
    return n;
  });
  set(!on);
  try {
    await api(`/api/items/${id}/watchlist`, { method: on ? 'DELETE' : 'POST' });
    return true;
  } catch {
    set(on);
    return false;
  } finally {
    listBusy.delete(id);
  }
}

export interface SubtitleStyle { size: 's' | 'm' | 'l' | 'xl'; color: 'white' | 'yellow' | 'cyan' | 'green'; background: 'none' | 'shadow' | 'semi' | 'solid'; font: 'sans' | 'serif' | 'mono' }
export type AudioFxPref = 'off' | 'voices' | 'night' | 'both';
export interface Prefs { autoplayNext: boolean; autoSkipIntro: boolean; shareHistory: boolean; shareRatings: boolean; hoverTrailers: boolean; hoverClip: boolean; /** detail view: start the title after the preview ran long enough */ autoStartPreview: boolean; audioLang: string; subtitleLang: string; quality: number; stillWatching: boolean; stillWatchingEpisodes: 2 | 3 | 4 | 5; subtitleStyle: SubtitleStyle; spoilerProtection: boolean; /** 1.1: "Show suggestions after the last episode" (post-play screen) */ postplay: boolean; /** anime without a series pref: original audio + subtitles in the UI language */ animeOriginal: boolean; weeklyDigest: boolean; ntfyTopic: string; /** calm mode: nothing autoplays (billboard, hover previews, detail preview), less motion */ calm: boolean; /** player sound processing (own endpoint, see saveAudioFx) */ audioFx: AudioFxPref; /** UI language of the profile ('' = never chosen, instance default applies) */ language: Locale | '' }
export const DEFAULT_PREFS: Prefs = { autoplayNext: true, autoSkipIntro: false, shareHistory: false, shareRatings: true, hoverTrailers: true, hoverClip: true, autoStartPreview: true, audioLang: '', subtitleLang: '', quality: 0, stillWatching: true, stillWatchingEpisodes: 3, subtitleStyle: { size: 'm', color: 'white', background: 'semi', font: 'sans' }, spoilerProtection: false, postplay: true, animeOriginal: false, weeklyDigest: true, ntfyTopic: '', calm: false, audioFx: 'off', language: '' };
/** Viewing preferences (server-side, follow the user across devices). */
export const prefs = writable<Prefs>({ ...DEFAULT_PREFS });
/** true once /api/prefs answered (before that `prefs` holds the defaults) */
export const prefsLoaded = writable(false);

/**
 * Fast-start copy of the calm flag per profile (localStorage): the cold-start brand intro has to decide before /api/prefs
 * answers. The server value stays authoritative; the copy is refreshed on every load / save.
 */
const calmKey = (profile: string | null | undefined) => `ff_calm:${profile || 'default'}`;
export function cachedCalm(profile: string | null | undefined): boolean {
  try { return localStorage.getItem(calmKey(profile)) === '1'; } catch { return false; }
}
function rememberCalm(on: boolean) {
  try { if (on) localStorage.setItem(calmKey(getActiveProfile()), '1'); else localStorage.removeItem(calmKey(getActiveProfile())); } catch { /* storage blocked */ }
}

/**
 * Calm mode on the document: `html.calm` plus one injected rule that flattens CSS animations/transitions (the same effect
 * as prefers-reduced-motion). Autoplay itself is stopped by `calmMode()` in #lib/preview.
 */
function applyCalm(on: boolean) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('calm', on);
  if (on && !document.getElementById('ff-calm-style')) {
    const st = document.createElement('style');
    st.id = 'ff-calm-style';
    st.textContent = 'html.calm *, html.calm *::before, html.calm *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; animation-delay: 0s !important; transition-duration: .001ms !important; scroll-behavior: auto !important; }';
    document.head.append(st);
  }
}
prefs.subscribe((p) => applyCalm(p.calm === true));
/** counts saveLanguage calls: a /api/prefs answer that was requested before a language switch must not undo it */
let langSaves = 0;
export async function loadPrefs() {
  const before = langSaves;
  try { const p = (await api('/api/prefs')).prefs;
    prefs.update((cur) => ({ ...DEFAULT_PREFS, ...p, subtitleStyle: { ...DEFAULT_PREFS.subtitleStyle, ...p?.subtitleStyle }, ...(langSaves !== before ? { language: cur.language } : {}) }));
    rememberCalm(p?.calm === true);
    prefsLoaded.set(true); } catch { /* defaults */ }
  void syncBadge(); // signed in and on the profile: show the unread count on the app icon (no-op where unsupported)
}
/**
 * Saves the viewing preferences. `language` is never sent: it has its own endpoint (saveLanguage), and a full PUT from
 * a form that was loaded before a switch (here or in another tab/device) would revert it. The server keeps the stored one.
 */
export async function savePrefs(p: Prefs) {
  const { language: _language, audioFx: _audioFx, ...body } = p;
  prefs.update((cur) => ({ ...p, language: cur.language, audioFx: cur.audioFx }));
  rememberCalm(p.calm === true);
  await api('/api/prefs', { method: 'PUT', body });
}

/**
 * Applies a new prefs value to a form without discarding unsaved edits: only fields that changed between the previous
 * and the new store value are taken over (e.g. `language` after a switch, or the server values after loadPrefs).
 */
export function mergePrefsInto(form: Prefs, prev: Prefs | null, next: Prefs): Prefs {
  if (!prev) return { ...next, subtitleStyle: { ...next.subtitleStyle } };
  const out: Record<string, unknown> = { ...form, subtitleStyle: { ...form.subtitleStyle } };
  for (const k of Object.keys(next) as Array<keyof Prefs>) {
    if (k === 'subtitleStyle') {
      for (const s of Object.keys(next.subtitleStyle) as Array<keyof SubtitleStyle>) {
        if (prev.subtitleStyle?.[s] !== next.subtitleStyle[s]) (out.subtitleStyle as Record<string, unknown>)[s] = next.subtitleStyle[s];
      }
    } else if (prev[k] !== next[k]) out[k] = next[k];
  }
  return out as unknown as Prefs;
}

/** Stores the player's sound processing of the active profile (follows the profile across devices). */
export async function saveAudioFx(v: AudioFxPref): Promise<void> {
  prefs.update((p) => ({ ...p, audioFx: v }));
  await api('/api/prefs/audiofx', { method: 'PUT', body: { audioFx: v } });
}

/**
 * Stores the UI language of the active profile (PUT /api/prefs/language), then switches the app to it
 * (pages re-render in the new language). Rejects when saving failed; nothing changes then.
 */
export async function saveLanguage(l: Locale): Promise<void> {
  await api('/api/prefs/language', { method: 'PUT', body: { language: l } });
  langSaves++;
  prefs.update((p) => ({ ...p, language: l }));
  const was = getLocale();
  const now = await setLocale(l);
  if (now !== was) remountPage(); // a switch the person made: rebuild the page once (see pageEpoch)
}
