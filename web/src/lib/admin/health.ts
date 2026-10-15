// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Status (Block 22): mirror of the backend health snapshot (`backend/src/health.ts`), the active streams view
 * (`playstats.ts`) and the aggregated error log (`errorlog.ts`), plus the pure helpers the page and the overview use.
 */
import { api } from '#lib/api';
import { tr, type TKey } from '#lib/i18n';
import type { Tone } from '#lib/ui/StatusPill.svelte';

export type Level = 'ok' | 'warn' | 'err' | 'off';
export const SERVICE_IDS = ['media', 'postgres', 'redis', 'gateway', 'oidc', 'requests', 'tmdb', 'omdb', 'playbackCheck'] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];
export const REASONS = [
  'slow', 'down', 'issuer_mismatch', 'invalid_key', 'paused', 'budget', 'not_set', 'failed_titles', 'unavailable',
  'full', 'low_free', 'cap', 'large', 'server_errors', 'client_errors', 'failed_playbacks', 'empty_media', 'pending_approvals',
] as const;
export type Reason = (typeof REASONS)[number];
export interface Detail { n?: number; pct?: number }
export interface ServiceHealth { id: ServiceId; level: Level; reason?: Reason; ms?: number; detail?: Detail }
export type DiskId = 'downloads' | 'previews' | 'database';
export interface DiskHealth {
  id: DiskId; level: Level; reason?: Reason; totalBytes?: number; freeBytes?: number; usedPct?: number; ownBytes: number; capBytes?: number;
  /** both volumes on one filesystem: this entry stands for both, `sharedBytes` is the other volume's own share */
  sharedWith?: 'downloads' | 'previews'; sharedBytes?: number;
}
export interface ErrorHealth { level: Level; reason?: Reason; server15: number; client15: number; playback60: number }
export interface HealthIssue { id: string; level: 'warn' | 'err'; reason: Reason; fp: string; detail?: Detail }
export interface HealthSnapshot { at: string; services: ServiceHealth[]; disks: DiskHealth[]; errors: ErrorHealth; issues: HealthIssue[]; worst: Level }

export const TC_REASONS = ['network', 'remoteCap', 'roleCap', 'container', 'videoCodec', 'audioCodec', 'audioTrack', 'subtitles', 'height', 'manual', 'other'] as const;
export type TranscodeReason = (typeof TC_REASONS)[number];
export type StreamMethod = 'direct' | 'remux' | 'transcode';
export interface StreamRow {
  userId: string | null; userName: string | null; profileName: string | null; device: string | null; title: string; seriesName: string | null;
  source: 'portal' | 'app'; method: StreamMethod | null; reason: TranscodeReason | null;
  videoCodec: string | null; audioCodec: string | null; hardware: boolean | null; paused: boolean;
}
export interface FailedPlayback { itemId: string; title: string | null; count: number; lastAt: string; code: string }
export interface StreamsView { streams: StreamRow[]; totals: Record<StreamMethod, number>; details: boolean; failed: FailedPlayback[] }

export type ErrorSource = 'server' | 'client' | 'playback' | 'job';
export interface ErrorEntry { source: ErrorSource; code: string; count: number; firstAt: string; lastAt: string; release?: string; sample?: string; itemId?: string }
export interface ErrorList { entries: ErrorEntry[]; overflow: number }

export const loadHealth = (refresh = false): Promise<HealthSnapshot> => api<HealthSnapshot>(`/api/admin/health${refresh ? '?refresh=1' : ''}`);
export const loadStreams = (): Promise<StreamsView> => api<StreamsView>('/api/admin/streams');
export const loadErrors = (hours = 24): Promise<ErrorList> => api<ErrorList>(`/api/admin/errors?hours=${hours}`);

const TONE: Record<Level, Tone> = { ok: 'ok', warn: 'warn', err: 'err', off: 'muted' };
export const levelTone = (l: Level): Tone => TONE[l];
/** icon of a level pill (never colour alone) */
export const levelIcon = (l: Level): string => ({ ok: 'check', warn: 'clock', err: 'alert', off: 'x' })[l];

const RANK: Record<Level, number> = { err: 0, warn: 1, ok: 2, off: 3 };
/** worst first: err, warn, ok, off (stable inside a level) */
export function sortServices<T extends { level: Level }>(s: readonly T[]): T[] {
  return s.map((x, i) => [x, i] as const).sort((a, b) => RANK[a[0].level] - RANK[b[0].level] || a[1] - b[1]).map(([x]) => x);
}

/** text key of a reason; a few reasons read differently for disks ("Nicht lesbar") than for services */
export function reasonKey(id: string, reason: Reason): TKey {
  if (id.startsWith('disk:') && reason === 'unavailable') return 'adminContent.health.disks.unreadable';
  return `adminContent.health.reason.${reason}` as TKey;
}

/** pill text of a service: the reason (with its numbers) or the plain level */
export function serviceText(s: Pick<ServiceHealth, 'id' | 'level' | 'reason' | 'detail'>): string {
  if (s.reason) return tr(reasonKey(`svc:${s.id}`, s.reason), { n: s.detail?.n ?? 0, pct: s.detail?.pct ?? 0 });
  if (s.id === 'playbackCheck' && s.level === 'off') return tr('adminContent.health.playbackNever');
  return tr(`adminContent.health.level.${s.level}` as TKey);
}

export const diskLabelKey = (d: DiskHealth): TKey => (d.sharedWith ? 'adminContent.health.disks.shared' : (`adminContent.health.disks.${d.id}` as TKey));

/** error codes are scrubbed by the server; addresses are cut here as well (a resource error names its URL) */
export const cleanCode = (code: string): string => code.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '…').trim();

/** short chip text of a transcode reason ("Videoformat"); `other` is stored as `misc` (an `other` key would read as a plural form) */
export const tcKey = (r: TranscodeReason): TKey => `adminContent.health.tc.${r === 'other' ? 'misc' : r}` as TKey;

/**
 * A playback-check / download error that means the media server answered with empty video (a hung hardware encoder returns
 * HTTP 200 with no bytes): the probe's "HTTP 200 empty body" / "empty playlist", the preparer's "empty segment from media server".
 */
export const isEmptyMediaError = (error: string | null | undefined): boolean =>
  Boolean(error && /HTTP 200 empty body|empty playlist|empty segment from media server/i.test(error));

/** every checked title failed and at least one with empty video: the hint is shown once above the list instead of under each row */
export const emptyHintOnTop = (results: ReadonlyArray<{ ok: boolean; error: string | null }>): boolean =>
  results.length > 0 && results.every((r) => !r.ok) && results.some((r) => isEmptyMediaError(r.error));
