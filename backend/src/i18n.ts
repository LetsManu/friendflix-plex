import type { Ctx } from './ctx.js';
import { CATALOGS, type Message, type MsgKey } from './messages.js';
export type { MsgKey } from './messages.js';

/**
 * UI languages of FriendFlix (codes as used by the web app, see web/src/lib/i18n and docs/i18n.md).
 * German is the source language and the fallback when nothing is configured.
 */
export const LANGUAGES = ['de', 'en', 'fr', 'es', 'it', 'tr', 'pl'] as const;
export type Language = (typeof LANGUAGES)[number];
export const FALLBACK_LANGUAGE: Language = 'de';
/** app_settings key of the instance default language (value: a JSON string, e.g. "de") */
export const DEFAULT_LANGUAGE_KEY = 'default_language';

export const isLanguage = (v: unknown): v is Language => typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v);

/** Instance default chosen by an admin, or null when none was stored yet (the admin is asked on the first visit). */
export async function instanceLanguage(ctx: Pick<Ctx, 'db'>): Promise<Language | null> {
  const r = await ctx.db.query<{ value: unknown }>('select value from app_settings where key=$1', [DEFAULT_LANGUAGE_KEY]);
  const v = r.rows[0]?.value;
  return isLanguage(v) ? v : null;
}

export async function setInstanceLanguage(ctx: Pick<Ctx, 'db'>, lang: Language): Promise<void> {
  await ctx.db.query(
    'insert into app_settings(key, value) values ($1, $2) on conflict (key) do update set value = excluded.value, updated_at = now()',
    [DEFAULT_LANGUAGE_KEY, JSON.stringify(lang)],
  );
}

/** Language stored for a profile (per-profile prefs `language`), or null when the profile never chose one. */
export async function profileLanguage(ctx: Pick<Ctx, 'db'>, profileId: string | null | undefined): Promise<Language | null> {
  if (!profileId) return null;
  const r = await ctx.db.query<{ l: string | null }>("select data->>'language' l from profile_prefs where profile_id=$1", [profileId]);
  const v = r.rows[0]?.l;
  return isLanguage(v) ? v : null;
}

/** Effective UI language of a profile: its own choice → instance default → German. */
export async function effectiveLanguage(ctx: Pick<Ctx, 'db'>, profileId: string | null | undefined): Promise<Language> {
  return (await profileLanguage(ctx, profileId)) ?? (await instanceLanguage(ctx)) ?? FALLBACK_LANGUAGE;
}

/**
 * Best supported language from an Accept-Language header ("en-US,en;q=0.9,de;q=0.8"), or null.
 * Only used as a suggestion for the first-login language picker; the server never switches languages on its own.
 */
export function languageFromAcceptLanguage(header: string | string[] | undefined): Language | null {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return null;
  const tags = raw.split(',').slice(0, 20).map((part, i) => {
    const [tag = '', ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const weight = q ? Number(q.slice(2)) : 1;
    return { base: tag.trim().toLowerCase().split('-')[0] ?? '', q: Number.isFinite(weight) ? weight : 0, i };
  }).filter((x) => x.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  return tags.map((x) => x.base).find(isLanguage) ?? null;
}

// ---- user-facing backend texts (notifications, push, ntfy/Discord, digest, labels) ----

/** BCP 47 tags used for number/date formatting (same as the web app's LOCALES). */
export const LANGUAGE_TAGS: Record<Language, string> = { de: 'de-DE', en: 'en-GB', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', tr: 'tr-TR', pl: 'pl-PL' };

/**
 * A text that is rendered in the recipient's language. Stored as JSON next to a notification (notifications.msg), so the
 * inbox can show it in the language of whoever reads it.
 * - a plain string is shown as is (names, titles, notes written by people)
 * - `{ key, params }` is a message of backend/src/messages.ts; params may be texts themselves (e.g. an achievement name)
 * - `{ join, sep }` joins several texts (default separator: newline)
 * - `{ date }` (only as a param) is an ISO timestamp formatted as date + time
 */
export type Text = string | { key: MsgKey; params?: Record<string, Param> } | { join: Text[]; sep?: string };
export type Param = Text | number | { date: string };

/** Shorthand for a message reference. */
export const m = (key: MsgKey, params?: Record<string, Param>): Text => (params ? { key, params } : { key });

const pluralCache = new Map<Language, Intl.PluralRules>();
const numberCache = new Map<Language, Intl.NumberFormat>();
const dateCache = new Map<Language, Intl.DateTimeFormat>();
const cached = <T>(map: Map<Language, T>, lang: Language, make: () => T): T => {
  let v = map.get(lang);
  if (!v) { v = make(); map.set(lang, v); }
  return v;
};

function pick(msg: Message, lang: Language, n: unknown): string {
  if (typeof msg === 'string') return msg;
  if (typeof n !== 'number') return msg.other;
  if (n === 0 && msg.zero !== undefined) return msg.zero;
  const cat = cached(pluralCache, lang, () => new Intl.PluralRules(LANGUAGE_TAGS[lang])).select(n) as keyof typeof msg;
  return msg[cat] ?? msg.other;
}

function renderParam(lang: Language, p: Param): string {
  if (typeof p === 'number') return cached(numberCache, lang, () => new Intl.NumberFormat(LANGUAGE_TAGS[lang])).format(p);
  if (p && typeof p === 'object' && 'date' in p) {
    const d = new Date(p.date);
    return Number.isNaN(d.getTime()) ? '' : cached(dateCache, lang, () => new Intl.DateTimeFormat(LANGUAGE_TAGS[lang], { dateStyle: 'medium', timeStyle: 'short' })).format(d);
  }
  return render(lang, p);
}

/** Message text of `key` in `lang` (missing → German → the key itself). Plural forms are chosen by the param `n`. */
export function msg(lang: Language, key: MsgKey | string, params?: Record<string, Param>): string {
  const cat = (CATALOGS[lang] ?? CATALOGS.de) as Record<string, Message | undefined>;
  const raw = cat[key] ?? (CATALOGS.de as Record<string, Message | undefined>)[key];
  if (raw === undefined) return key;
  const s = pick(raw, lang, params?.n);
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? renderParam(lang, params[name]!) : all));
}

/** Renders a Text in `lang`. Unknown shapes (e.g. corrupted JSON) render as an empty string. */
export function render(lang: Language, t: Text | null | undefined): string {
  if (t == null) return '';
  if (typeof t === 'string') return t;
  if (typeof t !== 'object') return '';
  if ('key' in t && typeof t.key === 'string') return msg(lang, t.key, t.params);
  if ('join' in t && Array.isArray(t.join)) return t.join.map((x) => render(lang, x)).filter(Boolean).join(typeof t.sep === 'string' ? t.sep : '\n');
  return '';
}

/** true when every message key inside `t` (also in params and joins) exists in the catalog (German is complete). */
export function knownText(t: Text | Param | null | undefined): boolean {
  if (t == null || typeof t !== 'object') return true;
  if ('key' in t) {
    if (typeof t.key !== 'string' || !(t.key in CATALOGS.de)) return false;
    return !t.params || typeof t.params !== 'object' || Object.values(t.params).every((p) => knownText(p));
  }
  if ('join' in t) return !Array.isArray(t.join) || t.join.every((x) => knownText(x));
  return true;
}

/**
 * Like render(), but null when the text refers to a message key that no longer exists (renamed/removed after it was
 * stored): msg() would show the raw key name then. Callers fall back to the text stored at creation time.
 */
export function renderKnown(lang: Language, t: Text | null | undefined): string | null {
  return knownText(t) ? render(lang, t) : null;
}

/** A notice rendered in one language (what ntfy / Discord / Web Push send). */
export interface Rendered { title: string; body?: string; link?: string; pushBody?: string }

export function renderNotice(n: { title: Text; body?: Text | null; link?: string; pushBody?: Text }, lang: Language): Rendered {
  const body = n.body == null ? undefined : render(lang, n.body) || undefined;
  const pushBody = n.pushBody == null ? undefined : render(lang, n.pushBody);
  return { title: render(lang, n.title), ...(body !== undefined ? { body } : {}), ...(n.link ? { link: n.link } : {}), ...(pushBody !== undefined ? { pushBody } : {}) };
}

/** true when the text needs the catalog (anything but a plain string). */
export const isMsg = (t: Text | null | undefined): boolean => t != null && typeof t !== 'string';

/** Language of an account's own messages (inbox, personal ntfy): the owner profile's choice → instance default → German. */
export const userLanguage = (ctx: Pick<Ctx, 'db'>, userId: string): Promise<Language> => effectiveLanguage(ctx, userId); // owner profile id = user id

/** Language for everyone at once (broadcasts, the global ntfy topic, Discord): instance default → German. */
export const broadcastLanguage = async (ctx: Pick<Ctx, 'db'>): Promise<Language> => (await instanceLanguage(ctx)) ?? FALLBACK_LANGUAGE;

/** Label of a built-in role in `lang`; a label changed via ROLES_JSON is shown as configured. */
export function roleLabel(lang: Language, role: string, configured: string | undefined, builtinGerman: string | undefined): string {
  if (configured && builtinGerman && configured === builtinGerman) return msg(lang, `role.${role}`);
  return configured ?? role;
}
