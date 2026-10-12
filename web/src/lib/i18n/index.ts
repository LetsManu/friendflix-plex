/**
 * FriendFlix i18n: a small store on top of Intl (no dependency). Documentation: docs/i18n.md.
 *
 *   .svelte:  import { t } from '#lib/i18n';           {$t('shell.nav.home')}  {$t('account.profiles.max', { n: 5 })}
 *   .ts:      import { tr, fmtDate } from '#lib/i18n';  tr('common.saveFailed')  fmtDate(iso)
 *
 * German is bundled; the other languages are loaded on demand (one chunk per language) and switched without a reload.
 * Missing keys fall back to German, then to the key itself (with a console warning in dev/test builds).
 */
import { derived, writable, type Readable } from 'svelte/store';
import de from './locales/de/index';
import { rememberOfflineLocale } from '../sw/locale';
import type { KeysOf, Message, PluralForms, TParams, Translation } from './types';

export type { PluralForms, TParams, Translation } from './types';
/** the German source dictionary (all areas) */
export type DeDict = typeof de;
/** every valid message key, e.g. 'shell.nav.home' */
export type TKey = KeysOf<DeDict>;
export type TFn = (key: TKey, params?: TParams) => string;

/** Supported UI languages: code, native name (shown in pickers), English name, BCP 47 tag used for Intl formatting. */
export const LOCALES = [
  { code: 'de', name: 'Deutsch', english: 'German', tag: 'de-DE' },
  { code: 'en', name: 'English', english: 'English', tag: 'en-GB' },
  { code: 'fr', name: 'Français', english: 'French', tag: 'fr-FR' },
  { code: 'es', name: 'Español', english: 'Spanish', tag: 'es-ES' },
  { code: 'it', name: 'Italiano', english: 'Italian', tag: 'it-IT' },
  { code: 'tr', name: 'Türkçe', english: 'Turkish', tag: 'tr-TR' },
  { code: 'pl', name: 'Polski', english: 'Polish', tag: 'pl-PL' },
] as const;
export type Locale = (typeof LOCALES)[number]['code'];
export const LOCALE_CODES: readonly Locale[] = LOCALES.map((l) => l.code);
export const DEFAULT_LOCALE: Locale = 'de';
/** localStorage key of the last used locale (lets the shell render in the right language before /api/me returns) */
export const LOCALE_KEY = 'ff-locale';

export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALE_CODES as readonly string[]).includes(v);
/** native name of a UI language ('Deutsch', 'English' …) */
export const localeName = (code: string): string => LOCALES.find((l) => l.code === code)?.name ?? code;
const tagOf = (l: Locale): string => LOCALES.find((x) => x.code === l)!.tag;

/** First supported language among BCP 47 candidates (e.g. navigator.languages: ['en-US', 'de']), or null. */
export function pickLocale(candidates: ReadonlyArray<string | null | undefined>): Locale | null {
  for (const c of candidates) {
    const base = (c ?? '').trim().toLowerCase().split(/[-_]/)[0];
    if (isLocale(base)) return base;
  }
  return null;
}

type AnyDict = Translation<DeDict>;
/** lazy loaders: one chunk per language (locales/<lang>/index.ts imports that language's area files) */
const LOADERS: Record<Exclude<Locale, 'de'>, () => Promise<{ default: AnyDict }>> = {
  en: () => import('./locales/en/index'),
  fr: () => import('./locales/fr/index'),
  es: () => import('./locales/es/index'),
  it: () => import('./locales/it/index'),
  tr: () => import('./locales/tr/index'),
  pl: () => import('./locales/pl/index'),
};
const dicts: Partial<Record<Locale, AnyDict>> = { de };

interface State { locale: Locale; dict: AnyDict }
const state = writable<State>({ locale: DEFAULT_LOCALE, dict: de });
let current: State = { locale: DEFAULT_LOCALE, dict: de };
state.subscribe((s) => (current = s));
const loadingStore = writable(false);

/** the active UI language */
export const locale: Readable<Locale> = derived(state, (s) => s.locale);
/** false while a language chunk is being loaded (the shell waits for it on first render) */
export const ready: Readable<boolean> = derived(loadingStore, (l) => !l);
/** current UI language (non-reactive, for .ts code) */
export const getLocale = (): Locale => current.locale;
/** BCP 47 tag for Intl / toLocale*String of the current language ('de-DE', 'en-GB' …) */
export const intlLocale = (): string => tagOf(current.locale);

/** Loads a language's dictionary (cached). Rejects when the chunk cannot be loaded (offline + not cached). */
export async function loadLocale(l: Locale): Promise<AnyDict> {
  const have = dicts[l];
  if (have) return have;
  const m = await LOADERS[l as Exclude<Locale, 'de'>]();
  dicts[l] = m.default;
  return m.default;
}

let seq = 0;
/**
 * Switches the UI language (unknown codes → German). Loads the language first, then updates every `$t`,
 * `<html lang>` and the remembered locale. The last call wins when several overlap. Resolves to the active locale.
 */
export async function setLocale(code: string | null | undefined): Promise<Locale> {
  const l: Locale = isLocale(code) ? code : DEFAULT_LOCALE;
  const my = ++seq;
  if (l === current.locale && dicts[l]) { loadingStore.set(false); return l; }
  loadingStore.set(!dicts[l]);
  let dict: AnyDict;
  try { dict = await loadLocale(l); } catch {
    if (my === seq) loadingStore.set(false);
    return current.locale; // chunk not reachable: stay in the current language
  }
  if (my !== seq) return current.locale;
  state.set({ locale: l, dict });
  loadingStore.set(false);
  if (typeof document !== 'undefined') document.documentElement.lang = l;
  try { localStorage.setItem(LOCALE_KEY, l); } catch { /* private mode */ }
  void rememberOfflineLocale(l); // the service worker precaches this language for /offline on its next install
  return l;
}

// ---- page re-render on a language switch ----
/**
 * The layout wraps the page in `{#key $pageEpoch}`: the page is rebuilt only when the person switches the language
 * (saveLanguage → remountPage), so texts computed in scripts (tr(), fmtDate() …) follow the switch. Applying the
 * language /api/me reports never rebuilds the page: the layout applies it before the page mounts (a rebuild would
 * start a second player / run every page request twice). Only `$t` texts follow such a late correction.
 */
const epoch = writable(0);
export const pageEpoch: Readable<number> = { subscribe: epoch.subscribe };
let keepers = 0;
/**
 * A page whose texts are all reactive (`$t`) can opt out of the rebuild, e.g. to keep unsaved form input
 * (settings). Call in onMount; returns the function that ends the opt-out (return it from onMount).
 */
export function keepPageOnSwitch(): () => void {
  keepers++;
  let done = false;
  return () => { if (!done) { done = true; keepers--; } };
}
/** rebuilds the page after a language switch the person made (no-op while a page opted out) */
export function remountPage(): void { if (!keepers) epoch.update((n) => n + 1); }

/** the language remembered in this browser (`ff-locale`), or null */
export function storedLocale(): Locale | null {
  try { const v = localStorage.getItem(LOCALE_KEY); return isLocale(v) ? v : null; } catch { return null; }
}
/**
 * Language of a public page that never calls /api/me (invite, TV pairing): the remembered one → the browser's languages
 * → null (then the page uses the instance default its own API answer carries).
 */
export function publicLocale(langs: ReadonlyArray<string> | undefined = typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : []): Locale | null {
  return storedLocale() ?? pickLocale(langs ?? []);
}

// ---- lookup + formatting ----
const warned = new Set<string>();
const DEV = Boolean(import.meta.env.DEV);

function lookup(dict: AnyDict | undefined, key: string): Message | undefined {
  let v: unknown = dict;
  for (const part of key.split('.')) {
    if (!v || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as PluralForms).other === 'string') return v as PluralForms;
  return undefined;
}

const plurals = new Map<string, Intl.PluralRules>();
function pluralRules(tag: string): Intl.PluralRules {
  let r = plurals.get(tag);
  if (!r) { r = new Intl.PluralRules(tag); plurals.set(tag, r); }
  return r;
}

/** Translate with an explicit state (used by `t`, `tr` and tests). */
function translate(s: State, key: string, params?: TParams): string {
  let msg = lookup(s.dict, key);
  let tag = tagOf(s.locale);
  if (msg === undefined && s.locale !== DEFAULT_LOCALE) { msg = lookup(de, key); tag = tagOf(DEFAULT_LOCALE); }
  if (msg === undefined) {
    if (DEV && !warned.has(key)) { warned.add(key); console.warn(`[i18n] missing key "${key}"`); }
    return key;
  }
  let text: string;
  if (typeof msg === 'string') text = msg;
  else {
    const n = Number(params?.n ?? params?.count ?? 0);
    const cat = n === 0 && msg.zero !== undefined ? 'zero' : pluralRules(tag).select(n);
    text = (msg as unknown as Record<string, string | undefined>)[cat] ?? msg.other;
  }
  if (!params || !text.includes('{')) return text;
  return text.replace(/\{(\w+)\}/g, (all, name: string) => {
    const v = params[name];
    if (v === undefined || v === null) return all;
    return typeof v === 'number' ? new Intl.NumberFormat(tag).format(v) : v;
  });
}

/** Reactive translator for components: `{$t('shell.nav.home')}`, `aria-label={$t('common.close')}`. */
export const t: Readable<TFn> = derived(state, (s) => (key: TKey, params?: TParams) => translate(s, key, params));
/** Non-reactive translator for .ts code (call it when the text is needed, never at module load). */
export const tr: TFn = (key, params) => translate(current, key, params);
/** Like `tr` but for keys built at runtime (e.g. `shell.menu.${id}`); unknown keys return the key and warn in dev. */
export const trDynamic = (key: string, params?: TParams): string => translate(current, key, params);
/** Translate in a specific language (falls back to German when that language is not loaded yet, see loadLocale). Used by the language pickers to preview. */
export const trIn = (l: Locale, key: TKey, params?: TParams): string => translate({ locale: dicts[l] ? l : DEFAULT_LOCALE, dict: dicts[l] ?? de }, key, params);
/** true when the key exists in German (useful for optional texts built from data) */
export const hasKey = (key: string): boolean => lookup(de, key) !== undefined;

// ---- Intl formatters (current language) ----
type DateIn = Date | string | number | null | undefined;
const toDate = (d: DateIn): Date | null => {
  if (d === null || d === undefined || d === '') return null;
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? null : x;
};

/** "12. Oktober 2026" / "12 October 2026" (pass Intl options to change the shape); '' for missing/invalid dates */
export function fmtDate(d: DateIn, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }): string {
  const x = toDate(d);
  return x ? x.toLocaleDateString(intlLocale(), opts) : '';
}
/** "12.10.2026, 18:30" / "12 Oct 2026, 18:30" */
export function fmtDateTime(d: DateIn, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }): string {
  const x = toDate(d);
  return x ? x.toLocaleString(intlLocale(), opts) : '';
}
/** "18:30" */
export function fmtTime(d: DateIn, opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }): string {
  const x = toDate(d);
  return x ? x.toLocaleTimeString(intlLocale(), opts) : '';
}
/** "1.234,5" / "1,234.5" */
export function fmtNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(intlLocale(), opts).format(n);
}
/** "gestern", "vor 3 Stunden", "in 2 Tagen" / "yesterday", "3 hours ago" (relative to `now`) */
export function fmtRelative(d: DateIn, now: number = Date.now()): string {
  const x = toDate(d);
  if (!x) return '';
  const sec = (x.getTime() - now) / 1000, a = Math.abs(sec);
  const [v, unit]: [number, Intl.RelativeTimeFormatUnit] =
    a < 45 ? [0, 'second'] : a < 3600 ? [sec / 60, 'minute'] : a < 86400 ? [sec / 3600, 'hour'] : a < 7 * 86400 ? [sec / 86400, 'day']
      : a < 30 * 86400 ? [sec / (7 * 86400), 'week'] : a < 365 * 86400 ? [sec / (30 * 86400), 'month'] : [sec / (365 * 86400), 'year'];
  return new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' }).format(Math.round(v), unit);
}
/** Run time from seconds: "1 Std. 52 Min." / "1 h 52 min", "45 Min.", "30 Sek." (patterns live in common.duration). */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return tr('common.duration.s', { s });
  const total = Math.round(s / 60), h = Math.floor(total / 60), m = total % 60;
  if (!h) return tr('common.duration.m', { m });
  return m ? tr('common.duration.hm', { h, m }) : tr('common.duration.h', { h });
}
/** "Deutsch, Englisch und Japanisch" / "German, English and Japanese" */
export function fmtList(items: readonly string[], type: 'conjunction' | 'disjunction' | 'unit' = 'conjunction'): string {
  return new Intl.ListFormat(intlLocale(), { style: 'long', type }).format(items);
}

// ---- boot: continue in the last used language (the shell waits for `ready` before its first render) ----
if (typeof window !== 'undefined') {
  let stored: string | null = null;
  try { stored = localStorage.getItem(LOCALE_KEY); } catch { /* blocked storage */ }
  if (isLocale(stored) && stored !== DEFAULT_LOCALE) void setLocale(stored);
}
