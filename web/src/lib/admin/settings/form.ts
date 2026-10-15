// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Settings form logic: drafts per key, what a save sends (only the fields that changed: a shown value may be redacted, e.g.
 * ntfy's `auth=redacted`, and must never be saved back), texts for codes, and the change kept across a re-authentication. That copy
 * lives in sessionStorage and never holds a secret or a URL with a credential in it: those are entered again.
 */
import { fmtList, hasKey, tr, trDynamic } from '#lib/i18n';
import type { ProbeResult, SettingGroup, SettingView } from './api';

/** A field's edited value: text, a switch, or null (a secret marked "remove"). */
export type Draft = string | boolean | null;

/** The value a field shows before any edit (secrets: always empty, they are write-only). */
export function shownDraft(v: SettingView): string | boolean {
  if (v.kind === 'bool') return v.value === true;
  if (v.kind === 'secret' || v.value === null || v.value === undefined) return '';
  if (Array.isArray(v.value)) return v.value.join(', ');
  return typeof v.value === 'object' ? JSON.stringify(v.value) : String(v.value);
}

const cidrs = (s: string) => s.split(',').map((c) => c.trim()).filter(Boolean).join(',');

/** The JSON a save sends for a draft: typed for switches and numbers, null for an emptied field (back to the default). */
export function submitValue(v: SettingView, d: Draft): unknown {
  if (d === null || typeof d === 'boolean') return d;
  const s = v.kind === 'secret' ? d : d.trim();
  if (!s) return null;
  if (v.kind === 'int' || v.kind === 'number') {
    const n = Number(s);
    return Number.isFinite(n) ? n : s; // the backend answers invalid_number
  }
  return v.kind === 'cidrList' ? cidrs(s) : s;
}

/** Whether a draft differs from what the field showed (typing the shown value back is no change). */
export function isChange(v: SettingView, d: Draft | undefined): boolean {
  if (d === undefined) return false;
  if (v.kind === 'secret') return d === null ? v.set : typeof d === 'string' && d !== '';
  const shown = shownDraft(v);
  if (typeof d === 'boolean' || typeof shown === 'boolean') return d !== shown;
  if (d === null) return shown !== '';
  return v.kind === 'cidrList' ? cidrs(d) !== cidrs(shown) : d.trim() !== shown.trim();
}

/** The values a save of these rows sends: only changed fields, never a locked (env) row. */
export function changedValues(items: readonly SettingView[], edits: Readonly<Record<string, Draft>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const v of items) {
    if (v.source === 'env' || !isChange(v, edits[v.key])) continue;
    out[v.key] = submitValue(v, edits[v.key]!);
  }
  return out;
}

/**
 * A draft that may sit in sessionStorage (an allowlist): a plain non-URL setting, a cleared field, or a URL without userinfo, query
 * string or fragment. Secrets and everything else are left out and entered again.
 */
export function keepable(v: SettingView, d: Draft): boolean {
  if (v.kind === 'secret') return false;
  if (v.kind !== 'url' || d === null || (typeof d === 'string' && d.trim() === '')) return true;
  if (typeof d !== 'string') return false;
  try {
    const u = new URL(d.trim());
    return !u.username && !u.password && !u.search && !u.hash && !d.includes('?') && !d.includes('#') && !d.includes('@');
  } catch {
    return false;
  }
}

/** The marker the backend puts into a shown URL instead of a credential (ntfy's `auth=` token). */
export const REDACTED = 'redacted';
/** A URL draft that still carries the redaction marker: saving it would replace the real token with the marker. */
export function stillRedacted(v: SettingView, d: Draft | undefined): boolean {
  if (v.kind !== 'url' || typeof d !== 'string' || !isChange(v, d)) return false;
  try {
    return [...new URL(d.trim()).searchParams.values()].includes(REDACTED);
  } catch {
    return /[?&]auth=redacted(&|#|$)/i.test(d);
  }
}
/** The keys of these rows whose edited URL still carries the redaction marker (refused before anything is sent). */
export const redactedKeys = (items: readonly SettingView[], edits: Readonly<Record<string, Draft>>): string[] =>
  items.filter((v) => v.source !== 'env' && stillRedacted(v, edits[v.key])).map((v) => v.key);

const STASH = 'ff_settings_pending';
/** a stashed change older than this is dropped (the re-authentication window is 10 minutes) */
const MAX_AGE_MS = 15 * 60_000;

export type PendingAction = 'save' | 'test';
/** An action interrupted by a re-authentication: what to repeat (exactly that), the group and the drafts that could be kept. */
export interface Pending {
  action: PendingAction; group: SettingGroup; edits: Record<string, Draft>;
  /** "Save anyway" (force) was chosen */
  force: boolean;
  /** a secret or credential URL was left out */
  dropped: boolean;
  at: number;
}

/** Keeps a group's changed drafts and the action for the return from the sign-in; returns whether something had to be left out. */
export function stashPending(action: PendingAction, group: SettingGroup, items: readonly SettingView[], edits: Readonly<Record<string, Draft>>,
  opts: { force?: boolean; now?: number } = {}): { dropped: boolean } {
  const kept: Record<string, Draft> = {};
  let dropped = false;
  for (const v of items) {
    const d = edits[v.key];
    if (v.source === 'env' || !isChange(v, d)) continue;
    if (keepable(v, d!)) kept[v.key] = d!;
    else dropped = true;
  }
  const p: Pending = { action, group, edits: kept, force: action === 'save' && opts.force === true, dropped, at: opts.now ?? Date.now() };
  try { sessionStorage.setItem(STASH, JSON.stringify(p)); } catch { /* storage blocked: the person types it again */ }
  return { dropped };
}

/** Drops a stashed change (failed re-authentication, sign-out). */
export function clearPending(): void {
  try { sessionStorage.removeItem(STASH); } catch { /* ignore */ }
}

/** Reads and removes the stashed change (null when there is none, it is too old or unreadable): it is used at most once. */
export function takePending(now = Date.now()): Pending | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(STASH);
    sessionStorage.removeItem(STASH);
  } catch { return null; }
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<Pending>;
    if (typeof p.group !== 'string' || !p.edits || typeof p.edits !== 'object' || typeof p.at !== 'number' || now - p.at > MAX_AGE_MS || p.at > now) return null;
    if (p.action !== 'save' && p.action !== 'test') return null;
    const edits: Record<string, Draft> = {};
    for (const [k, d] of Object.entries(p.edits)) if (typeof d === 'string' || typeof d === 'boolean' || d === null) edits[k] = d;
    return { action: p.action, group: p.group as SettingGroup, edits, force: p.action === 'save' && p.force === true, dropped: p.dropped === true, at: p.at };
  } catch { return null; }
}

/** The setting's label (the key itself for a key this version has no text for). */
export const keyLabel = (key: string): string => (hasKey(`settings.keys.${key}.label`) ? trDynamic(`settings.keys.${key}.label`) : key);
export const keyHelp = (key: string): string => (hasKey(`settings.keys.${key}.help`) ? trDynamic(`settings.keys.${key}.help`) : '');

/** The env names to remove after a move; legacy names of an old product are summarised, not named. */
export function moveHint(names: readonly string[]): string {
  const own = names.filter((n) => !/seerr/i.test(n));
  const list = fmtList(own);
  return tr('settings.moveHint', { keys: own.length < names.length ? tr('settings.moveHintOlder', { keys: list }) : list });
}

/** Text of a field error code (400 invalid_settings). */
export const errorText = (code: string): string =>
  (/^[a-z_]+$/.test(code) && hasKey(`settings.errors.${code}`) ? trDynamic(`settings.errors.${code}`) : tr('settings.errors.invalid'));

/** Text of a probe result: the code's sentence plus the detail's, when there is one. */
export function probeText(r: ProbeResult): string {
  const code = hasKey(`settings.probe.${r.code}`) ? trDynamic(`settings.probe.${r.code}`) : tr('settings.probe.invalid');
  const detail = r.detail && /^[a-z_]+$/.test(r.detail) && hasKey(`settings.probeDetail.${r.detail}`) ? trDynamic(`settings.probeDetail.${r.detail}`) : '';
  return detail ? `${code} ${detail}` : code;
}
