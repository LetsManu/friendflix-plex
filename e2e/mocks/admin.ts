// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin API fixtures for the mocked FriendFlix backend (shapes follow backend/src/routes/admin.ts, seerr.ts, polls.ts,
 * hubs.ts, digest.ts). Stateful: mutations change the state, so specs can assert what the UI did.
 * Wired into installApi (mocks/api.ts); switch the session to an admin with `api.asAdmin = true` before page.goto().
 */

const NOW = Date.now();
const ago = (h: number): string => new Date(NOW - h * 3600e3).toISOString();
const fut = (h: number): string => new Date(NOW + h * 3600e3).toISOString();
/** access_until set and not in the future (the backend refuses to unlock such an account: 409 access_expired) */
const accessEnded = (until: string | null): boolean => until !== null && Date.parse(until) <= Date.now();
/** uuid-shaped ids (the backend validates uuids for users/devices) */
export const auid = (n: number): string => `00000000-0000-4000-a000-${n.toString().padStart(12, '0')}`;

export interface AdminUser { id: string; name: string; email: string | null; role: string; disabled: boolean; jellyfin_username: string; seerr_user_id: number | null; created_at: string; last_seen: string | null; access_until?: string | null; profiles?: number; /** why a locked account is locked (default manual) */ locked_reason?: 'manual' | 'expired' | 'deletion'; /** scheduled deletion (Block 23 self-service) */ deletion_at?: string | null; /** claimed by the deletion tick, users row still there (steps 1-4) */ cleanup?: { step: number; error: string | null } }
/** a claimed deletion whose users row is gone (status=deleting lists it by pseudonym); step = the step in work (1-6) */
export interface AdminCleanup { id: string; pseudonym: string; started_at: string; step: number; error: string | null }
export interface AdminDevice { user_id: string; device_id: string; label: string; approved: boolean; last_seen: string; name: string; /** the admin's own device (backend: current) */ current?: boolean }
export interface AdminRequest { id: number; title: string; mediaType: 'movie' | 'tv'; requestedBy: string; status: string; createdAt: string }
export interface AdminInvite { id: string; role: string; note: string | null; expires_at: string; used_at: string | null; used_by_name: string | null; uses: number; max_uses: number; access_days: number | null }
/** open approval request (GET /api/admin/approvals) */
export interface AdminApproval { id: string; name: string; email: string | null; requested_at: string }
export interface PreviewRow { itemId: string; name: string; type: string; status: 'ok' | 'failed' | 'missing' | 'preparing'; bytes: number | null; audioLang: string | null; error: string | null; createdAt: string | null }
export interface AuditRow { id: number; at: string; action: string; target: string | null; meta: Record<string, unknown>; actor: string | null; target_name: string | null }

export const ROLES = {
  admin: { label: 'Admin', builtinLabel: true }, friend: { label: 'Freund', builtinLabel: true }, family: { label: 'Familie', builtinLabel: true }, guest: { label: 'Gast', builtinLabel: true },
};
const NAMES = ['Anna Beispiel', 'Ben Test', 'Clara Fischer', 'David Müller', 'Emma Schneider', 'Felix Weber', 'Greta Wagner', 'Hannes Becker', 'Ida Hoffmann', 'Jonas Schäfer', 'Katharina Bauer-Langenberger', 'Leon Richter'];

export interface AdminState {
  users: AdminUser[];
  devices: AdminDevice[];
  /** every request; the list endpoint filters by state */
  requests: AdminRequest[];
  invites: AdminInvite[];
  /** accounts made from an invite (GET /api/admin/invites/:id/uses) */
  inviteUses: Record<string, Array<{ id: string; name: string; email: string | null; role: string; disabled: boolean; at: string }>>;
  approvals: AdminApproval[];
  audit: AuditRow[];
  polls: Array<{ id: string; title: string; creator: string; winnerOptionId: string; closesAt?: string; options: Array<{ id: string; title: string; votes?: number; inLibrary?: boolean }> }>;
  lists: Array<{ id: string; name: string; owner: { id: string; name: string }; itemCount: number; featured: boolean }>;
  hubs: Array<{ id: string; name: string; source: string; sourceValue: string; accent?: string | null; imageItemId?: string | null; enabled: boolean }>;
  /** hover-preview clips of the library (content pages) */
  previews: PreviewRow[];
  /** streams running right now (/api/admin/live) */
  live: Array<{ userId: string; userName: string; profileName: string | null; playSessionId: string; itemId: string; title: string; seriesName: string | null; type: string | null; positionTicks: number; runtimeTicks: number | null; isPaused: boolean; updatedAt: string; source: string }>;
  /** Seerr reachable (summary.services.seerr, request counts) */
  seerrUp: boolean;
  /** make GET /api/admin/summary fail (500) */
  summaryFails: boolean;
  /** recommendation item index (summary.recoIndex) */
  recoIndex: { supported: boolean; running: boolean; items: number; updatedAt: string | null };
  /** removal dates ("Bald weg", /api/admin/leaving) */
  leaving: LeavingRow[];
  /** optional TMDB/OMDb keys (/api/admin/sources); the real API never returns more than last4 */
  sources: SourceRow[];
  /** Block 22: health snapshot (/api/admin/health); `healthRefreshed` replaces it on ?refresh=1 */
  health: Record<string, any>;
  healthRefreshed: Record<string, any> | null;
  /** query strings of /api/admin/health calls ('' or '?refresh=1') */
  healthCalls: string[];
  /** Block 23 phase 3: /api/admin/health/login (backend flowCheck.ts LoginCheck) */
  loginCheck: Record<string, any>;
  /** POST /api/admin/authentik/repair: the bodies received and the answer (the result's `check` replaces loginCheck) */
  repairs: Array<Record<string, unknown>>;
  repairReply: Record<string, any> | null;
  /** /api/admin/streams */
  streams: Record<string, any>;
  /** /api/admin/errors */
  errors: { entries: Array<Record<string, any>>; overflow: number };
  /** Block 22 banner: the snapshot's issues (/api/admin/health/banner minus dismissals), dismissals by id → fp, number of banner calls */
  bannerIssues: Array<{ id: string; level: 'warn' | 'err'; reason: string; fp: string; detail?: { n?: number; pct?: number } }>;
  dismissed: Record<string, string>;
  bannerCalls: number;
  bannerFails: boolean;
  /** Block 22 library hygiene (/api/admin/hygiene*): rows with every issue, ignored "itemId|code" pairs, scan state */
  hygiene: HygieneMock;
  /** Block 22 usage (/api/admin/usage*): query strings of the list calls, user ids of detail calls, `since` */
  usageCalls: string[];
  usageDetailCalls: string[];
  usageSince: string | null;
  /** Block 23 user detail (/api/admin/users/:id*): Authentik state (mfa null = no Authentik API), link health, limits, profiles, activity calls */
  detailMfa: { totp: boolean; webauthn: boolean; static: boolean } | null;
  /** Block 23 self-service: deletions whose users row is gone, and ids the deletion tick has claimed (restore answers 409) */
  cleanups: AdminCleanup[];
  claimed: Set<string>;
  authentik: { recovery: boolean; mfaSetup: boolean };
  linkedOk: { jellyfin: boolean | null; requests: boolean };
  limits: Record<string, DetailLimits>;
  userProfiles: Record<string, DetailProfile[]>;
  activityCalls: number;
  /** licences revoked via DELETE /api/admin/downloads/:id */
  revokedLicences: string[];
}
export interface DetailLimits { maxStreams: number | null; remoteBitrate: number | null; maxDownloads: number | null; downloadMaxHeight: number | null; requestsPerMonth: number | null }
export interface DetailProfile { id: string; name: string; kids: boolean; maxRating: string | null; avatar: string; lastUsed: string | null; isOwner: boolean; hasPin: boolean }
/** role values the limits page shows as placeholders */
export const DETAIL_ROLE_LIMITS: DetailLimits = { maxStreams: 2, remoteBitrate: 8_000_000, maxDownloads: 5, downloadMaxHeight: 720, requestsPerMonth: 3 };
export type HygieneCode = 'no_overview' | 'no_poster' | 'no_backdrop' | 'no_year' | 'no_ids' | 'no_audio' | 'audio_unknown' | 'foreign_no_subs' | 'forced_only' | 'image_subs_only' | 'dup_ids' | 'dup_title' | 'dup_episode' | 'no_source' | 'zero_runtime' | 'heavy_bitrate' | 'hevc_10bit' | 'video_codec' | 'audio_codec';
export interface HygieneItem {
  itemId: string; type: 'Movie' | 'Series' | 'Episode'; name: string; seriesId: string | null; seriesName: string | null; year: number | null;
  issues: HygieneCode[]; versions: number; container: string | null; bitrate: number | null; sizeBytes: number | null;
  video: string | null; audio: string[]; subtitles: string[]; dupOf: string[];
}
export interface HygieneMock {
  supported: boolean; canRefresh: boolean; running: boolean; lastDone: string | null; lastFull: string | null;
  items: HygieneItem[]; ignored: Set<string>; refreshed: string[]; scans: number;
}
export const HYG_CAT: Record<HygieneCode, 'info' | 'language' | 'duplicate' | 'file'> = {
  no_overview: 'info', no_poster: 'info', no_backdrop: 'info', no_year: 'info', no_ids: 'info',
  no_audio: 'language', audio_unknown: 'language', foreign_no_subs: 'language', forced_only: 'language', image_subs_only: 'language',
  dup_ids: 'duplicate', dup_title: 'duplicate', dup_episode: 'duplicate',
  no_source: 'file', zero_runtime: 'file', heavy_bitrate: 'file', hevc_10bit: 'file', video_codec: 'file', audio_codec: 'file',
};
const HYG_WARN = new Set<HygieneCode>(['no_overview', 'no_poster', 'no_audio', 'foreign_no_subs', 'dup_ids', 'dup_episode', 'no_source', 'zero_runtime', 'video_codec']);
const hx = (n: number): string => n.toString(16).padStart(32, '0');
function hygieneItems(): HygieneItem[] {
  const base = { seriesId: null, seriesName: null, versions: 1, container: 'mkv', bitrate: 12e6, sizeBytes: 4.2 * 1024 ** 3, video: 'h264 1080p', audio: ['deu ac3 6ch'], subtitles: ['deu'], dupOf: [] };
  const rows: HygieneItem[] = [
    { ...base, itemId: hx(0x701), type: 'Movie', name: 'Lantern Bay', year: 2019, issues: ['foreign_no_subs', 'hevc_10bit'], video: 'hevc 10-bit 2160p HDR', audio: ['eng eac3 6ch'], subtitles: [], bitrate: 48e6, sizeBytes: 38 * 1024 ** 3 },
    { ...base, itemId: hx(0x702), type: 'Movie', name: 'Quiet Harbor', year: 2004, issues: ['no_poster', 'no_backdrop'] },
    { ...base, itemId: hx(0x703), type: 'Movie', name: 'Ironwood', year: 2011, issues: ['dup_ids'], dupOf: [hx(0x704)] },
    { ...base, itemId: hx(0x704), type: 'Movie', name: 'Ironwood', year: 2011, issues: ['dup_ids'], dupOf: [hx(0x703)], versions: 2 },
    { ...base, itemId: hx(0x705), type: 'Series', name: 'Sundial', year: 2020, issues: ['no_overview'], container: null, bitrate: null, sizeBytes: null, video: null, audio: [], subtitles: [] },
    { ...base, itemId: hx(0x706), type: 'Episode', name: 'Pilot', seriesId: hx(0x705), seriesName: 'Sundial', year: 2020, issues: ['image_subs_only'], subtitles: ['deu pgs'] },
    { ...base, itemId: hx(0x707), type: 'Movie', name: 'Old Reel', year: 1962, issues: ['video_codec', 'audio_codec'], container: 'avi', video: 'mpeg2 576p', audio: ['eng dts 2ch'] },
  ];
  for (let i = 0; i < 60; i++) rows.push({ ...base, itemId: hx(0x800 + i), type: 'Episode', name: `Folge ${i + 1}`, seriesId: hx(0x7ff), seriesName: 'Zephyr Road', year: 2015, issues: ['heavy_bitrate'], bitrate: 41e6 + i * 1e5 });
  return rows;
}
export interface SourceRow { name: 'tmdb' | 'omdb'; set: boolean; last4: string | null; from: 'db' | 'file' | null; invalid: boolean; usedToday?: number; budget?: number }
export interface LeavingRow { itemId: string; name: string | null; type: string | null; year: number | null; leavesAt: string; days: number; note: string | null; setBy: string | null }
/** local calendar day `offset` days from today (YYYY-MM-DD) */
export const leaveDay = (offset: number): string => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const LEAVING_TITLES: Record<string, [string, string, number]> = {
  '00000000000000000000000000000001': ['Inkwell', 'Movie', 2010], '00000000000000000000000000000002': ['Interlace', 'Movie', 2014],
  '00000000000000000000000000000003': ['The Dawn Keeper', 'Movie', 2008], '00000000000000000000000000000004': ['Dunwick', 'Movie', 2017],
};
const leavingRow = (itemId: string, days: number, note: string | null): LeavingRow => {
  const t = LEAVING_TITLES[itemId];
  return { itemId, name: t?.[0] ?? null, type: t?.[1] ?? null, year: t?.[2] ?? null, leavesAt: leaveDay(days), days, note, setBy: 'Tester' };
};

const previewItems: PreviewRow[] = Array.from({ length: 60 }, (_, i) => ({ itemId: 'it' + i, name: 'Titel Nummer ' + i, type: i % 3 ? 'Movie' : 'Series', status: (['ok', 'ok', 'ok', 'failed', 'missing', 'preparing'] as const)[i % 6]!, bytes: i % 6 < 3 ? 3_400_000 + i * 1000 : null, audioLang: i % 6 < 3 ? 'deu' : null, error: i % 6 === 3 ? 'ffmpeg exited with code 1' : null, createdAt: ago(i) }));

export function adminState(): AdminState {
  const users: AdminUser[] = [
    { id: 'u1', name: 'Tester', email: 'tester@example.org', role: 'admin', disabled: false, jellyfin_username: 'tester', seerr_user_id: 1, created_at: ago(24 * 400), last_seen: ago(0.1) },
    ...NAMES.map((n, i) => ({ id: auid(i + 2), name: n, email: i % 3 === 2 ? null : `${n.split(' ')[0]!.toLowerCase()}@example.org`, role: ['friend', 'family', 'guest', 'friend'][i % 4]!, disabled: i === 4, jellyfin_username: n.split(' ')[0]!.toLowerCase(), seerr_user_id: null, created_at: ago(24 * (i + 3)), last_seen: ago(i * 7) })),
  ];
  return {
    users,
    devices: Array.from({ length: 8 }, (_, i) => ({ user_id: auid(i + 2), device_id: `dev-${i}-0123456789ab`, label: ['Chrome auf Windows', 'Safari auf iPhone', 'LG webOS TV', 'Firefox auf Linux'][i % 4]!, approved: i > 3, last_seen: ago(i * 11 + 1), name: NAMES[i]! })),
    requests: [
      { id: 101, title: 'Dunmoor: Part Two', mediaType: 'movie', requestedBy: 'Anna Beispiel', status: 'angefragt', createdAt: ago(3) },
      { id: 102, title: 'Sundial', mediaType: 'tv', requestedBy: 'Ben Test', status: 'angefragt', createdAt: ago(9) },
      { id: 103, title: 'Paper Lanterns', mediaType: 'movie', requestedBy: 'Clara Fischer', status: 'angefragt', createdAt: ago(20) },
      { id: 104, title: 'Silkroad', mediaType: 'tv', requestedBy: 'David Müller', status: 'angefragt', createdAt: ago(30) },
      { id: 105, title: 'The Bramble', mediaType: 'tv', requestedBy: 'Clara Fischer', status: 'genehmigt', createdAt: ago(50) },
      { id: 106, title: 'Quiet Mornings', mediaType: 'movie', requestedBy: 'Emma Schneider', status: 'verfügbar', createdAt: ago(90) },
    ],
    invites: [
      { id: auid(201), role: 'friend', note: 'Für Annas Bruder', expires_at: fut(30), used_at: null, used_by_name: null, uses: 0, max_uses: 1, access_days: null },
      { id: auid(202), role: 'guest', note: null, expires_at: ago(5), used_at: null, used_by_name: null, uses: 0, max_uses: 1, access_days: null },
      { id: auid(203), role: 'family', note: 'Oma', expires_at: fut(2), used_at: ago(1), used_by_name: 'Oma Inge', uses: 1, max_uses: 1, access_days: null },
      { id: auid(204), role: 'guest', note: 'Spieleabend', expires_at: fut(40), used_at: ago(3), used_by_name: 'Mila Kraus', uses: 2, max_uses: 5, access_days: 30 },
    ],
    inviteUses: {
      [auid(203)]: [{ id: auid(50), name: 'Oma Inge', email: null, role: 'family', disabled: false, at: ago(1) }],
      [auid(204)]: [{ id: auid(51), name: 'Mila Kraus', email: 'mila@example.org', role: 'guest', disabled: false, at: ago(3) }, { id: auid(52), name: 'Tom Kraus', email: null, role: 'guest', disabled: false, at: ago(2) }],
    },
    approvals: [
      { id: auid(401), name: 'Mia Neu', email: 'mia@example.org', requested_at: ago(2) },
      { id: auid(402), name: 'Paul Fremd', email: null, requested_at: ago(20) },
    ],
    audit: [
      { id: 50, at: ago(0.2), action: 'user.disable', target: auid(6), meta: {}, actor: 'Tester', target_name: 'Emma Schneider' },
      { id: 49, at: ago(1), action: 'user.role', target: auid(3), meta: { from: 'guest', to: 'friend' }, actor: 'Tester', target_name: 'Ben Test' },
      { id: 48, at: ago(2), action: 'invite.create', target: auid(201), meta: { role: 'friend', authentik: true }, actor: 'Tester', target_name: null },
      { id: 47, at: ago(5), action: 'device.approve', target: auid(7), meta: { by: 'admin' }, actor: 'Tester', target_name: 'Felix Weber' },
      { id: 46, at: ago(8), action: 'request.approve', target: '99', meta: {}, actor: 'Tester', target_name: null },
      { id: 45, at: ago(26), action: 'list.feature', target: '11111111-1111-4111-8111-111111111111', meta: {}, actor: 'Tester', target_name: 'Filmabend' },
      { id: 44, at: ago(30), action: 'role.playback', target: 'family', meta: { transcoding: true, maxHeight: 1080 }, actor: 'Tester', target_name: null },
      { id: 43, at: ago(49), action: 'user.provisioned', target: auid(13), meta: {}, actor: null, target_name: 'Leon Richter' },
      { id: 42, at: ago(60), action: 'system.update', target: null, meta: { from: 'a', to: 'b' }, actor: 'Tester', target_name: null },
    ],
    polls: [{ id: 'p1', title: 'Filmabend Freitag', creator: 'Anna Beispiel', winnerOptionId: 'o2', closesAt: ago(2), options: [{ id: 'o1', title: 'Hearth', votes: 2, inLibrary: true }, { id: 'o2', title: 'Dunmoor: Part Two', votes: 5, inLibrary: false }] }],
    lists: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Filmabend', owner: { id: auid(2), name: 'Anna' }, itemCount: 12, featured: true },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Annas Klassiker', owner: { id: auid(3), name: 'Ben' }, itemCount: 4, featured: false },
    ],
    hubs: [
      { id: 'h1', name: 'Mythos', source: 'studio', sourceValue: 'Mythos Studios', enabled: true },
      { id: 'h2', name: 'Pinecone', source: 'studio', sourceValue: 'Pinecone', accent: '#3a7bd5', enabled: false },
    ],
    previews: previewItems.map((p) => ({ ...p })),
    live: [
      { userId: auid(2), userName: 'Anna Beispiel', profileName: 'Anna', playSessionId: 'ps-anna', itemId: 'it1', title: 'Hearth', seriesName: null, type: 'Movie', positionTicks: 30 * 6e8, runtimeTicks: 170 * 6e8, isPaused: false, updatedAt: ago(0), source: 'portal' },
      { userId: auid(3), userName: 'Ben Test', profileName: null, playSessionId: 'ps-ben', itemId: 'it2', title: 'Pilot', seriesName: 'Sundial', type: 'Episode', positionTicks: 10 * 6e8, runtimeTicks: 55 * 6e8, isPaused: true, updatedAt: ago(0), source: 'portal' },
    ],
    seerrUp: true,
    summaryFails: false,
    recoIndex: { supported: true, running: false, items: 1234, updatedAt: ago(3) },
    leaving: [leavingRow('00000000000000000000000000000001', 1, 'Lizenz endet'), leavingRow('00000000000000000000000000000002', 5, null), leavingRow('00000000000000000000000000000003', 20, 'Rechte laufen aus')],
    sources: [{ name: 'tmdb', set: false, last4: null, from: null, invalid: false }, { name: 'omdb', set: true, last4: 'k3y9', from: 'db', invalid: false, usedToday: 12, budget: 900 }],
    health: healthOk(),
    healthRefreshed: null,
    healthCalls: [],
    loginCheck: loginCheckOk(),
    repairs: [],
    repairReply: null,
    streams: { streams: [], totals: { direct: 0, remux: 0, transcode: 0 }, details: true, failed: [] },
    errors: { entries: [], overflow: 0 },
    bannerIssues: [],
    dismissed: {},
    bannerCalls: 0,
    bannerFails: false,
    hygiene: { supported: true, canRefresh: true, running: false, lastDone: ago(0.2), lastFull: ago(48), items: hygieneItems(), ignored: new Set(), refreshed: [], scans: 0 },
    usageCalls: [],
    usageDetailCalls: [],
    usageSince: leaveDay(-10),
    detailMfa: { totp: true, webauthn: false, static: true },
    cleanups: [],
    claimed: new Set(),
    authentik: { recovery: true, mfaSetup: false },
    linkedOk: { jellyfin: true, requests: true },
    limits: {},
    userProfiles: {},
    activityCalls: 0,
    revokedLicences: [],
  };
}

const profilesOf = (st: AdminState, u: AdminUser): DetailProfile[] => (st.userProfiles[u.id] ??= [
  { id: `${u.id.slice(0, -4)}p001`, name: u.name.split(' ')[0]!, kids: false, maxRating: null, avatar: 'a2', lastUsed: u.last_seen, isOwner: true, hasPin: false },
  { id: `${u.id.slice(0, -4)}p002`, name: 'Kinder', kids: true, maxRating: 'FSK-6', avatar: 'a4', lastUsed: null, isOwner: false, hasPin: true },
]);
/** GET /api/admin/users/:id (shape of backend/src/routes/adminUsers.ts; never credentials or the Authentik sub) */
function userDetail(st: AdminState, u: AdminUser) {
  const profiles = profilesOf(st, u);
  return {
    user: { id: u.id, name: u.name, email: u.email, role: u.role, disabled: u.disabled, lockedReason: u.disabled ? (u.locked_reason ?? 'manual') : null, accessUntil: u.access_until ?? null, deletionAt: u.deletion_at ?? null, createdAt: u.created_at, lastActive: u.last_seen, avatar: null },
    mfa: st.detailMfa,
    authentik: st.authentik,
    totals: { d7: { hours: 3.5, streams: 4 }, d30: { hours: 12.5, streams: 15 }, all: { hours: 140, streams: 230 }, downloads: 3, requests: 7 },
    linked: { jellyfin: { ok: st.linkedOk.jellyfin, username: u.jellyfin_username }, requests: { ok: st.linkedOk.requests, id: st.linkedOk.requests ? 7 : null } },
    profiles,
    devices: st.devices.filter((d) => d.user_id === u.id).map((d, i) => ({ id: d.device_id, name: d.label, lastSeen: d.last_seen, approved: d.approved, sessions: i + 1 })),
    licenses: [{ id: auid(601), itemId: 'it1', status: 'fetched', ready: true, title: 'Hearth', seriesName: null, season: null, episode: null, profileId: profiles[0]!.id, createdAt: ago(30), validUntil: fut(24 * 20), expiresAt: fut(24 * 20), bytes: 1.2e9 }].filter((l) => !st.revokedLicences.includes(l.id)),
  };
}

/** Block 22: aggregated usage per account (shapes follow backend/src/routes/usage.ts; never a title) */
function usageRows(st: AdminState, days: number) {
  const f = days / 30;
  return st.users.map((u, i) => {
    const streams = i === 0 ? 8 : i === 1 ? 12 : i % 3 === 0 ? 0 : Math.round((i + 2) * f);
    return {
      userId: u.id, name: u.name, role: u.role, disabled: u.disabled, lastSeen: u.last_seen,
      seconds: i === 0 ? Math.round(5400 * f) : streams * 2400, movieSeconds: i === 0 ? Math.round(3600 * f) : streams * 1200, seriesSeconds: i === 0 ? Math.round(1800 * f) : streams * 1200,
      titles: Math.ceil(streams / 2), streams, transcodes: i === 0 ? 2 : Math.floor(streams / 4), topReason: i === 0 ? 'videoCodec' : streams >= 4 ? 'network' : null,
      devices: i === 0 ? 3 : 1, devicesUsed: i === 0 ? 2 : streams ? 1 : 0, liveNow: st.live.filter((l) => l.userId === u.id).length,
    };
  });
}
function usageDetail(userId: string, days: number) {
  const out = [];
  for (let d = days - 1; d >= 0; d--) out.push({ day: leaveDay(-d), seconds: d % 3 === 0 ? 1800 + d * 60 : 0 });
  return {
    userId, days: out,
    devices: [
      { label: 'Chrome auf Windows', lastSeen: ago(1), streams: 5, transcodes: 1, app: false },
      { label: 'Infuse', lastSeen: leaveDay(-2), streams: 3, transcodes: 1, app: true },
      { label: '', lastSeen: null, streams: 1, transcodes: 0, app: false },
    ],
    reasons: { videoCodec: 2, network: 1 }, since: leaveDay(-10),
  };
}

const hygEff = (h: HygieneMock, r: HygieneItem): HygieneCode[] => r.issues.filter((c) => !h.ignored.has(`${r.itemId}|${c}`));
function hygieneSummary(h: HygieneMock) {
  const byCategory = { info: 0, language: 0, duplicate: 0, file: 0 };
  const byIssue: Record<string, number> = {};
  let total = 0;
  for (const r of h.items) {
    const eff = hygEff(h, r);
    if (!eff.length) continue;
    total++;
    for (const c of new Set(eff.map((x) => HYG_CAT[x]))) byCategory[c]++;
    for (const c of eff) byIssue[c] = (byIssue[c] ?? 0) + 1;
  }
  return { state: { supported: h.supported, running: h.running, lastDone: h.lastDone, lastFull: h.lastFull }, total, byCategory, byIssue, ignored: h.ignored.size, canRefresh: h.canRefresh };
}
function hygieneList(h: HygieneMock, sp: URLSearchParams) {
  const cat = sp.get('category'), issue = sp.get('issue'), type = sp.get('type'), series = sp.get('seriesId'), q = (sp.get('q') ?? '').toLowerCase();
  let rows = h.items.map((r) => ({ r, eff: hygEff(h, r) })).filter(({ r, eff }) => eff.length
    && (!cat || eff.some((c) => HYG_CAT[c] === cat)) && (!issue || eff.includes(issue as HygieneCode)) && (!type || r.type === type)
    && (!series || r.seriesId === series) && (!q || `${r.name} ${r.seriesName ?? ''}`.toLowerCase().includes(q)));
  const sort = sp.get('sort') ?? 'name';
  const dir = (sp.get('dir') ?? (sort === 'name' ? 'asc' : 'desc')) === 'asc' ? 1 : -1;
  const key = (x: { r: HygieneItem; eff: HygieneCode[] }): string | number => (sort === 'issues' ? x.eff.length : sort === 'size' ? x.r.sizeBytes ?? -1 : sort === 'bitrate' ? x.r.bitrate ?? -1 : `${x.r.seriesName ?? x.r.name} ${x.r.name}`.toLowerCase());
  rows = [...rows].sort((a, b) => { const x = key(a), y = key(b); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'de', { numeric: true })) * dir; });
  const off = Number(sp.get('offset') ?? 0), lim = Number(sp.get('limit') ?? 50);
  return { items: rows.slice(off, off + lim).map(({ r, eff }) => ({ ...r, issues: eff.map((code) => ({ code, severity: HYG_WARN.has(code) ? 'warn' : 'info' })) })), total: rows.length };
}

const GiB = 1024 ** 3;
/** Block 23 phase 3: a healthy sign-in check */
export function loginCheckOk(): Record<string, any> {
  const row = (kind: string, slug: string, state = 'ok') => ({ kind, slug, state, stages: [] });
  return {
    mode: 'app', implicitConsent: true, authCodeGrant: true, issuerMatches: true, passkeys: 'in-app', passkeysReason: 'ok', unreachable: false, warnings: [],
    flows: [row('login', 'default-authentication-flow'), row('recovery', 'default-recovery-flow'), row('invalidation', 'default-invalidation-flow'), row('setup-totp', 'default-authenticator-totp-setup')],
  };
}

/** Block 22: a healthy snapshot (shapes follow backend/src/health.ts) */
export function healthOk(): Record<string, any> {
  return {
    at: new Date().toISOString(),
    services: [
      { id: 'media', level: 'ok', ms: 40 }, { id: 'postgres', level: 'ok', ms: 2 }, { id: 'redis', level: 'ok', ms: 1 }, { id: 'gateway', level: 'ok', ms: 12 },
      { id: 'oidc', level: 'ok', ms: 80 }, { id: 'requests', level: 'ok', ms: 30 }, { id: 'tmdb', level: 'off', reason: 'not_set' }, { id: 'omdb', level: 'ok' }, { id: 'playbackCheck', level: 'ok' },
    ],
    disks: [
      { id: 'downloads', level: 'ok', totalBytes: 500 * GiB, freeBytes: 300 * GiB, usedPct: 40, ownBytes: 12 * GiB, capBytes: 50 * GiB },
      { id: 'previews', level: 'ok', totalBytes: 100 * GiB, freeBytes: 80 * GiB, usedPct: 20, ownBytes: 99e6 },
      { id: 'database', level: 'ok', ownBytes: 300e6 },
    ],
    errors: { level: 'ok', server15: 0, client15: 0, playback60: 0 },
    issues: [],
    worst: 'ok',
  };
}

const PENDING = 'angefragt';
const STATE_KEY: Record<string, string> = { angefragt: 'pending', genehmigt: 'approved', 'in Arbeit': 'processing', 'verfügbar': 'available', abgelehnt: 'declined' };
const reqFilter: Record<string, (r: AdminRequest) => boolean> = {
  pending: (r) => r.status === PENDING, approved: (r) => r.status === 'genehmigt', processing: (r) => r.status === 'in Arbeit', available: (r) => r.status === 'verfügbar', all: () => true,
};

// ---- People list endpoints (users, devices, invites, audit): search / filter / sort / paging like the backend ----
const norm = (v: string): string => v.toLowerCase();
function paged<T>(rows: T[], sp: URLSearchParams, def: number): { slice: T[]; total: number } {
  const limit = Number(sp.get('limit') ?? def), offset = Number(sp.get('offset') ?? 0);
  return { slice: rows.slice(offset, offset + limit), total: rows.length };
}
function sorted<T>(rows: T[], sp: URLSearchParams, keys: Record<string, (r: T) => string | number>): T[] {
  const k = keys[sp.get('sort') ?? ''];
  if (!k) return rows;
  const dir = sp.get('dir') === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => { const x = k(a), y = k(b); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir; });
}
const WEEK = 7 * 86400e3;
function usersList(st: AdminState, sp: URLSearchParams) {
  const q = norm(sp.get('q') ?? ''), status = sp.get('status'), inactive = sp.get('lastActive') === '90+', lastActive = inactive ? 0 : Number(sp.get('lastActive') ?? 0), now = Date.now();
  // status=pending: the open approval requests in the same row shape (backend: pending true, role null)
  const all = status === 'pending'
    ? st.approvals.map((a) => ({ id: a.id, name: a.name, email: a.email, role: null as unknown as string, disabled: false, jellyfin_username: '', seerr_user_id: null, created_at: a.requested_at, last_seen: null, access_until: null, locked_reason: null, deletion_at: null as string | null, cleanup: null as { step: number; error: string | null; gone: boolean } | null, profiles: 0, devices: 0, pending: true }))
    : st.users.map((u) => ({ ...u, access_until: u.access_until ?? null, locked_reason: u.disabled ? (u.locked_reason ?? 'manual') : null, deletion_at: u.deletion_at ?? null,
      cleanup: status === 'deleting' && u.cleanup ? { ...u.cleanup, gone: false } : null, profiles: u.profiles ?? 1, devices: st.devices.filter((d) => d.user_id === u.id).length, pending: false }))
      // status=deleting: plus the cleanup rows (backend: pseudonym as name, no e-mail or role, cleanup {step, error})
      .concat(status === 'deleting' ? st.cleanups.map((c) => ({ id: c.id, name: c.pseudonym, email: null, role: null as unknown as string, disabled: true, jellyfin_username: '', seerr_user_id: null, created_at: c.started_at, last_seen: null, access_until: null, locked_reason: 'deletion' as const, deletion_at: null, profiles: 0, devices: 0, pending: false, cleanup: { step: c.step, error: c.error, gone: true } })) : []);
  let rows = all.filter((u) => (!q || norm(`${u.name} ${u.email ?? ''} ${u.jellyfin_username}`).includes(q)) && (!sp.get('role') || u.role === sp.get('role'))
    && (!status || status === 'pending' || (status === 'locked' && u.disabled) || (status === 'active' && !u.disabled && !u.deletion_at)
      || (status === 'deleting' && (Boolean(u.deletion_at) || Boolean(u.cleanup)))
      || (status === 'expiring' && u.access_until !== null && Date.parse(u.access_until) >= now && Date.parse(u.access_until) <= now + WEEK))
    && (!lastActive || (u.last_seen !== null && Date.parse(u.last_seen) >= now - lastActive * 86400e3))
    && (!inactive || u.last_seen === null || Date.parse(u.last_seen) < now - 90 * 86400e3));
  rows = sorted(rows, sp, { name: (u) => u.name, email: (u) => u.email ?? '', role: (u) => u.role, status: (u) => Number(u.disabled), lastSeen: (u) => u.last_seen ?? '', accessUntil: (u) => u.access_until ?? '', profiles: (u) => u.profiles, devices: (u) => u.devices });
  const { slice, total } = paged(rows, sp, 1000);
  return { users: slice, total };
}
function devicesList(st: AdminState, sp: URLSearchParams) {
  const q = norm(sp.get('q') ?? '');
  let rows = [...st.devices].sort((a, b) => Number(a.approved) - Number(b.approved) || b.last_seen.localeCompare(a.last_seen));
  rows = rows.filter((d) => (!q || norm(`${d.name} ${d.label}`).includes(q)) && (!sp.get('status') || (sp.get('status') === 'approved') === d.approved));
  rows = sorted(rows, sp, { user: (d) => d.name, device: (d) => d.label, lastSeen: (d) => d.last_seen, status: (d) => Number(d.approved) });
  const { slice, total } = paged(rows, sp, 300);
  return { devices: slice, total, pending: st.devices.filter((d) => !d.approved).length };
}
function invitesList(st: AdminState, sp: URLSearchParams) {
  const q = norm(sp.get('q') ?? ''), now = new Date().toISOString();
  const status = (i: AdminInvite) => (i.uses >= i.max_uses ? 'used' : i.expires_at < now ? 'expired' : 'open');
  let rows = st.invites.filter((i) => (!q || norm(`${i.note ?? ''} ${i.role} ${i.used_by_name ?? ''}`).includes(q)) && (!sp.get('status') || status(i) === sp.get('status')));
  rows = sorted(rows, sp, { role: (i) => i.role, note: (i) => i.note ?? '', validUntil: (i) => i.expires_at, status: (i) => status(i) });
  const { slice, total } = paged(rows, sp, 100);
  return { invites: slice.map((i) => ({ ...i, created_at: i.expires_at })), total };
}
const AUDIT_ACTOR = 'Tester';
function auditList(st: AdminState, sp: URLSearchParams) {
  const q = norm(sp.get('q') ?? ''), action = sp.get('action'), actor = sp.get('actor'), from = sp.get('from'), to = sp.get('to');
  let rows = st.audit.filter((e) => (!q || norm(`${e.action} ${e.actor ?? ''} ${e.target_name ?? ''}`).includes(q))
    && (!action || e.action === action || e.action.startsWith(`${action}.`))
    && (!actor || (actor === 'system' ? e.actor === null : e.actor === AUDIT_ACTOR))
    && (!from || e.at >= from) && (!to || e.at <= to));
  if (sp.get('dir') === 'asc') rows = [...rows].reverse();
  const { slice, total } = paged(rows, sp, 100);
  return { entries: slice.map((e) => ({ ...e, actor_id: e.actor ? 'u1' : null })), total };
}

export function adminSummary(st: AdminState) {
  const pendingReq = st.requests.filter((r) => r.status === PENDING).length;
  const locked = st.users.filter((u) => u.disabled).length;
  return {
    users: { total: st.users.length, active: st.users.length - locked, locked },
    pending: { requests: st.seerrUp ? pendingReq : null, devices: st.devices.filter((d) => !d.approved).length, polls: st.polls.length, invites: st.invites.filter((i) => i.uses < i.max_uses && i.expires_at > new Date().toISOString()).length, previewsFailed: 10 },
    requests: st.seerrUp ? { pending: pendingReq, approved: st.requests.filter((r) => r.status === 'genehmigt').length, processing: 1, available: st.requests.filter((r) => r.status === 'verfügbar').length, declined: 2, total: st.requests.length + 3 } : null,
    storage: { downloadsEnabled: true, downloadsBytes: 12.4 * 1024 ** 3, downloadsMaxBytes: 50 * 1024 ** 3, previewBytes: 99e6, previewClips: 30 },
    playbackCheck: { finishedAt: ago(2), total: 20, failed: 1 },
    services: { jellyfin: true, seerr: st.seerrUp },
    live: { streams: 2, partyRooms: 1 },
    recoIndex: st.recoIndex,
  };
}


type Reply = (body: unknown, status?: number) => Promise<void>;

/**
 * Answers an /api/admin/** call; returns null when the path is not an admin endpoint (the caller then reports it as unmocked).
 * `body` is the parsed JSON request body.
 */
export function adminRoute(st: AdminState, m: string, p: string, sp: URLSearchParams, body: any, J: Reply): Promise<void> | null {
  let mm: RegExpMatchArray | null;
  const ok = () => J({ ok: true });
  const log = (action: string, target: string | null, meta: Record<string, unknown> = {}, target_name: string | null = null) =>
    st.audit.unshift({ id: (st.audit[0]?.id ?? 0) + 1, at: new Date().toISOString(), action, target, meta, actor: 'Tester', target_name });

  // R4: CTR and play rate per recommendation engine (the server's counters)
  if (p === '/api/admin/reco') return J({
    engine: 'shadow', locked: false, fallbacks: 3, since: '2026-10-18T08:00:00.000Z',
    engines: {
      v1: { impressions: 400, clicks: 40, plays: 20, dismisses: 4, ctr: 0.1, playRate: 0.05 },
      v2: { impressions: 0, clicks: 0, plays: 0, dismisses: 0, ctr: null, playRate: null },
    },
  });
  if (p === '/api/admin/summary') return st.summaryFails ? J({ error: 'boom' }, 500) : J(adminSummary(st));
  if (p === '/api/admin/status') {
    const s = adminSummary(st);
    return J({ users: s.users.active, pendingDevices: s.pending.devices, openInvites: s.pending.invites, pendingPolls: s.pending.polls, activeStreams: 2, partyRooms: 1, jellyfin: true });
  }

  // ---- people ----
  if (p === '/api/admin/users') return J(usersList(st, sp));
  // ---- user detail (Block 23) ----
  if ((mm = p.match(/^\/api\/admin\/users\/([0-9a-f-]{36}|u1)(\/.*)?$/)) && !(m === 'PATCH' && !mm[2]) && mm[2] !== '/revoke-sessions') {
    const u = st.users.find((x) => x.id === mm![1]);
    if (!u) return J({ error: 'not_found' }, 404);
    const rest = mm[2] ?? '';
    let sub: RegExpMatchArray | null;
    if (!rest && m === 'GET') return J(userDetail(st, u));
    if (rest === '/activity' && m === 'GET') {
      st.activityCalls++;
      log('user.activity_viewed', u.id, { profiles: 2 }, u.name);
      const pr = profilesOf(st, u);
      return J({ items: [
        { id: 'it1', name: 'Hearth', type: 'Movie', played: false, playedPercentage: 45.4, lastPlayedDate: ago(2), profile: { id: pr[0]!.id, name: pr[0]!.name } },
        { id: 'it2', name: 'Pilot', type: 'Episode', seriesName: 'Sundial', parentIndexNumber: 1, indexNumber: 1, played: true, lastPlayedDate: ago(30), profile: { id: pr[1]!.id, name: pr[1]!.name } },
      ], skipped: [] });
    }
    if (rest === '/audit' && m === 'GET') {
      const rows = st.audit.filter((e) => e.target === u.id);
      const { slice, total } = paged(rows, sp, 50);
      return J({ entries: slice.map((e) => ({ ...e, actor_id: e.actor ? 'u1' : null })), total });
    }
    if (rest === '/limits') {
      const cur = (st.limits[u.id] ??= { maxStreams: null, remoteBitrate: null, maxDownloads: null, downloadMaxHeight: null, requestsPerMonth: null });
      if (m === 'GET') return J({ limits: cur, role: DETAIL_ROLE_LIMITS });
      if (m === 'PUT') { const to = { ...cur, ...body }; log('user.limits', u.id, { from: cur, to }, u.name); st.limits[u.id] = to; return J({ limits: to }); }
    }
    if (rest === '/repair' && m === 'POST') {
      st.linkedOk = { jellyfin: st.linkedOk.jellyfin === false ? true : st.linkedOk.jellyfin, requests: true };
      log('user.repair', u.id, {}, u.name);
      return J({ ok: true, jellyfin: { identities: 2, failed: 0 }, requests: { ok: true, id: 7 } });
    }
    if (rest === '/recovery' && m === 'POST') { log('user.recovery_email', u.id, { ok: true }, u.name); return ok(); }
    if (rest === '/mfa-setup' && m === 'POST') return J({ error: 'not_supported' }, 501);
    // Block 23 self-service: cancel a scheduled deletion (ended access stays locked as expired), or let the next tick delete it
    if (rest === '/deletion/restore' && m === 'POST') {
      if (st.claimed.has(u.id)) return J({ error: 'deletion_in_progress' }, 409);
      if (!u.deletion_at || u.locked_reason !== 'deletion') return J({ error: 'not_scheduled' }, 409);
      u.deletion_at = null;
      if (accessEnded(u.access_until ?? null)) { u.locked_reason = 'expired'; log('user.deletion_restored', u.id, { lockedReason: 'expired' }, u.name); }
      else { u.disabled = false; u.locked_reason = undefined; log('user.enable', u.id, {}, u.name); log('user.deletion_restored', u.id, {}, u.name); }
      return ok();
    }
    if (rest === '/deletion/now' && m === 'POST') {
      if (u.id === 'u1') return J({ error: 'cannot_lock_yourself_out' }, 400);
      if (!u.deletion_at || u.locked_reason !== 'deletion') return J({ error: 'not_scheduled' }, 409);
      const to = new Date().toISOString();
      log('user.deletion_now', u.id, { from: u.deletion_at, to }, u.name);
      u.deletion_at = to;
      return ok();
    }
    if ((sub = rest.match(/^\/sessions\/([^/]+)\/revoke$/)) && m === 'POST') { log('user.revoke_device', u.id, { deviceId: sub[1] }, u.name); return J({ revoked: 1 }); }
    if ((sub = rest.match(/^\/profiles\/([^/]+)$/)) && m === 'PATCH') {
      const pr = profilesOf(st, u).find((x) => x.id === sub![1]);
      if (!pr) return J({ error: 'not_found' }, 404);
      if (body.name && profilesOf(st, u).some((x) => x !== pr && x.name.toLowerCase() === String(body.name).toLowerCase())) return J({ error: 'name_taken' }, 409);
      const from = { name: pr.name, hasPin: pr.hasPin };
      if (body.name) pr.name = body.name;
      if (body.resetPin) pr.hasPin = false;
      log('profile.admin_update', u.id, { from, to: { name: pr.name, hasPin: pr.hasPin } }, u.name);
      return J({ profile: pr });
    }
    return null;
  }
  if ((mm = p.match(/^\/api\/admin\/users\/([^/]+)$/)) && m === 'PATCH') {
    const u = st.users.find((x) => x.id === mm![1]);
    if (!u) return J({ error: 'not_found' }, 404);
    if (u.id === 'u1' && (body.disabled || (body.role && body.role !== 'admin'))) return J({ error: 'cannot_lock_yourself_out' }, 400);
    const until = body.accessUntil !== undefined ? body.accessUntil : u.access_until ?? null;
    if (body.disabled === false && u.disabled && accessEnded(until)) return J({ error: 'access_expired' }, 409);
    if (body.role && body.role !== u.role) { log('user.role', u.id, { from: u.role, to: body.role }, u.name); u.role = body.role; }
    if (typeof body.disabled === 'boolean' && body.disabled !== u.disabled) { u.disabled = body.disabled; log(body.disabled ? 'user.disable' : 'user.enable', u.id, {}, u.name); }
    if (body.accessUntil !== undefined) {
      log('user.access', u.id, { from: u.access_until ?? null, to: body.accessUntil }, u.name); u.access_until = body.accessUntil;
      if (u.disabled && u.locked_reason === 'expired' && !accessEnded(body.accessUntil)) { u.disabled = false; u.locked_reason = undefined; log('user.enable', u.id, {}, u.name); }
    }
    return ok();
  }
  if ((mm = p.match(/^\/api\/admin\/users\/([^/]+)\/revoke-sessions$/)) && m === 'POST') return J({ revoked: 2 });
  if (p === '/api/admin/users/bulk' && m === 'POST') {
    const users = (body.ids as string[]).map((id) => st.users.find((u) => u.id === id));
    if (users.some((u) => !u)) return J({ error: 'not_found' }, 404);
    if ((body.action === 'lock' || (body.action === 'role' && body.role !== 'admin')) && body.ids.includes('u1')) return J({ error: 'cannot_lock_yourself_out' }, 400);
    if (body.action === 'unlock' && (users as AdminUser[]).some((u) => u.disabled && accessEnded(u.access_until ?? null))) return J({ error: 'access_expired' }, 409);
    let done = 0;
    for (const u of users as AdminUser[]) {
      if (body.action === 'lock' || body.action === 'unlock') {
        const d = body.action === 'lock';
        if (u.disabled === d) continue;
        u.disabled = d; log(d ? 'user.disable' : 'user.enable', u.id, {}, u.name);
      } else if (body.action === 'role') {
        if (u.role === body.role) continue;
        log('user.role', u.id, { from: u.role, to: body.role }, u.name); u.role = body.role;
      } else if (body.action === 'access') {
        log('user.access_until', u.id, { from: u.access_until ?? null, to: body.accessUntil }, u.name); u.access_until = body.accessUntil;
      }
      done++;
    }
    return J({ done });
  }
  if (p === '/api/admin/approvals' && m === 'GET') return J({ requests: st.approvals });
  if ((mm = p.match(/^\/api\/admin\/approvals\/([^/]+)\/(approve|reject)$/)) && m === 'POST') {
    const a = st.approvals.find((x) => x.id === mm![1]);
    if (!a) return J({ error: 'not_found' }, 404);
    st.approvals = st.approvals.filter((x) => x !== a);
    if (mm[2] === 'reject') { log('user.rejected', a.id, { from: 'pending', to: 'rejected', name: a.name, message: body?.message ?? null }); return ok(); }
    const id = auid(500 + st.users.length);
    st.users.push({ id, name: a.name, email: a.email, role: body.role, disabled: false, jellyfin_username: a.name.split(' ')[0]!.toLowerCase(), seerr_user_id: null, created_at: new Date().toISOString(), last_seen: null, access_until: body.accessUntil ?? null });
    log('user.approved', id, { from: 'pending', to: body.role }, a.name);
    return J({ id });
  }
  if (p === '/api/admin/roles' && m === 'GET') {
    return J({ roles: ROLES, invitable: ['friend', 'family', 'guest'], limits: Object.entries(ROLES).map(([role, r], i) => ({ role, label: r.label, builtinLabel: true, requestsPerMonth: i === 0 ? null : 3, isDefault: i === 2, transcoding: i !== 3, maxHeight: i === 1 ? 1080 : null, download: i < 2, maxDownloads: 5, downloadMaxHeight: 720, downloadDays: 30, maxBitrate: role === 'guest' ? 2_000_000 * 4 : 40_000_000, remoteMaxBitrate: role === 'family' ? 12_000_000 : role === 'guest' ? 4_000_000 : 8_000_000, remoteDefault: role === 'guest' ? 4_000_000 : 8_000_000, remoteIsDefault: role !== 'family' })) });
  }
  if (/^\/api\/admin\/roles\/[^/]+$/.test(p) && m === 'PUT') return ok();
  if (p === '/api/admin/devices') return J(devicesList(st, sp));
  if (p === '/api/admin/devices/approve' && m === 'POST') {
    const d = st.devices.find((x) => x.user_id === body.userId && x.device_id === body.deviceId);
    if (!d) return J({ error: 'not_found' }, 404);
    d.approved = true; log('device.approve', d.user_id, { by: 'admin' }, d.name);
    return ok();
  }
  if ((p === '/api/admin/devices/unapprove' || p === '/api/admin/devices/remove') && m === 'POST') {
    const d = st.devices.find((x) => x.user_id === body.userId && x.device_id === body.deviceId);
    if (!d) return J({ error: 'not_found' }, 404);
    if (p.endsWith('/remove')) { st.devices = st.devices.filter((x) => x !== d); log('device.remove', d.user_id, { by: 'admin' }, d.name); } else { d.approved = false; log('device.unapprove', d.user_id, { by: 'admin' }, d.name); }
    return ok();
  }
  if (p === '/api/admin/invites' && m === 'GET') return J(invitesList(st, sp));
  if (p === '/api/admin/invites' && m === 'POST') {
    const id = auid(300 + st.invites.length);
    const maxUses = body.maxUses ?? 1;
    st.invites.unshift({ id, role: body.role, note: body.note ?? null, expires_at: fut(body.ttlHours ?? 48), used_at: null, used_by_name: null, uses: 0, max_uses: maxUses, access_days: body.accessDays ?? null });
    log('invite.create', id, { role: body.role, maxUses, accessDays: body.accessDays ?? null });
    return J({ id, link: `https://portal.example.com/invite/${'t'.repeat(32)}`, authentik: 'ok', expiresAt: fut(body.ttlHours ?? 48), uses: 0, maxUses });
  }
  if ((mm = p.match(/^\/api\/admin\/invites\/([^/]+)\/uses$/)) && m === 'GET') {
    if (!st.invites.some((i) => i.id === mm![1])) return J({ error: 'not_found' }, 404);
    return J({ uses: st.inviteUses[mm[1]!] ?? [] });
  }
  // revoke: an unused invite is deleted, a partly used one is closed (max_uses = uses), a used-up one stays
  if ((mm = p.match(/^\/api\/admin\/invites\/([^/]+)$/)) && m === 'DELETE') {
    const inv = st.invites.find((i) => i.id === mm![1]);
    if (inv && inv.uses === 0) st.invites = st.invites.filter((i) => i !== inv);
    else if (inv) inv.max_uses = inv.uses;
    log('invite.revoke', mm[1]!);
    return ok();
  }
  if (p === '/api/admin/audit') return J(auditList(st, sp));
  if (p === '/api/admin/audit/filters') return J({ actors: [{ id: 'u1', name: AUDIT_ACTOR }], system: st.audit.some((e) => e.actor === null), categories: [...new Set(st.audit.map((e) => e.action.split('.')[0]!))].sort() });

  // ---- content ----
  if (p === '/api/admin/requests') {
    if (!st.seerrUp) return J({ error: 'seerr_unreachable' }, 502);
    const all = st.requests.filter(reqFilter[sp.get('filter') ?? 'pending'] ?? reqFilter.pending!);
    const skip = Number(sp.get('skip') ?? 0), take = Number(sp.get('take') ?? 50);
    return J({ requests: all.slice(skip, skip + take).map((r) => ({ ...r, statusKey: STATE_KEY[r.status] ?? 'unknown' })), total: all.length });
  }
  if ((mm = p.match(/^\/api\/admin\/requests\/(\d+)\/(approve|decline)$/)) && m === 'POST') {
    const r = st.requests.find((x) => x.id === Number(mm![1]));
    if (!r) return J({ error: 'not_found' }, 404);
    r.status = mm[2] === 'approve' ? 'genehmigt' : 'abgelehnt';
    log(`request.${mm[2]}`, String(r.id));
    return ok();
  }
  if (p === '/api/admin/polls') return J({ polls: st.polls });
  if ((mm = p.match(/^\/api\/admin\/polls\/([^/]+)\/(approve|reject)$/)) && m === 'POST') { st.polls = st.polls.filter((x) => x.id !== mm![1]); log(`poll.${mm[2]}`, mm[1]!); return ok(); }
  if (p === '/api/admin/lists') {
    const q = (sp.get('q') ?? '').toLowerCase();
    const hit = st.lists.filter((l) => (!q || l.name.toLowerCase().includes(q) || l.owner.name.toLowerCase().includes(q)) && (sp.get('featured') === null || l.featured === (sp.get('featured') === '1')));
    const off = Number(sp.get('offset') ?? 0), lim = Number(sp.get('limit') ?? 200);
    return J({ lists: hit.slice(off, off + lim), total: hit.length, featuredCount: st.lists.filter((l) => l.featured).length, max: 5 });
  }
  if ((mm = p.match(/^\/api\/admin\/lists\/([^/]+)\/featured$/)) && m === 'PUT') {
    const l = st.lists.find((x) => x.id === mm![1]);
    if (!l) return J({ error: 'not_found' }, 404);
    l.featured = Boolean(body.featured);
    return J({ ok: true, featured: l.featured });
  }
  if (p === '/api/admin/hubs' && m === 'GET') return J({ max: 8, hubs: st.hubs });
  if (p === '/api/admin/hubs' && m === 'POST') { const h = { id: 'h' + (st.hubs.length + 1), ...body }; st.hubs.push(h); return J({ hub: h }); }
  if (p === '/api/admin/hubs/order' && m === 'PUT') { st.hubs = (body.ids as string[]).map((id) => st.hubs.find((h) => h.id === id)!).filter(Boolean); return ok(); }
  if (p === '/api/admin/hubs/suggestions') return J({ suggestions: ['Action', 'Drama', 'Krimi', 'Sci-Fi', 'Aster 9', 'Wardell'].map((n, i) => ({ name: n, count: 10 + i, source: i < 4 ? 'genre' : 'studio', sourceValue: n, used: false })) });
  if ((mm = p.match(/^\/api\/admin\/hubs\/([^/]+)$/))) {
    if (m === 'DELETE') { st.hubs = st.hubs.filter((h) => h.id !== mm![1]); return ok(); }
    if (m === 'PUT') { const h = st.hubs.find((x) => x.id === mm![1]); if (h) Object.assign(h, body); return J({ hub: h }); }
  }
  if (p === '/api/admin/previews' && m === 'GET') {
    const rows = st.previews;
    const n = (x: string) => rows.filter((r) => r.status === x).length;
    const summary = { total: rows.length, ok: n('ok'), failed: n('failed'), missing: n('missing'), preparing: n('preparing'), totalBytes: rows.reduce((a, r) => a + (r.bytes ?? 0), 0) };
    const ORDER = { failed: 0, preparing: 1, missing: 2, ok: 3 };
    if (!sp.has('limit') && !sp.has('ids') && !sp.has('status') && !sp.has('q')) return J({ summary, items: [...rows].sort((a, b) => ORDER[a.status] - ORDER[b.status]) });
    let list = rows;
    if (sp.has('ids')) { const want = new Set((sp.get('ids') ?? '').split(',').filter(Boolean)); list = list.filter((r) => want.has(r.itemId)); }
    if (sp.get('status')) list = list.filter((r) => r.status === sp.get('status'));
    if (sp.get('q')) list = list.filter((r) => r.name.toLowerCase().includes(sp.get('q')!.toLowerCase()));
    const sign = sp.get('dir') === 'desc' ? -1 : 1, key = sp.get('sort') ?? 'status';
    list = [...list].sort((a, b) => key === 'name' ? sign * a.name.localeCompare(b.name, 'de', { numeric: true }) : key === 'size' ? sign * ((a.bytes ?? -1) - (b.bytes ?? -1)) : sign * (ORDER[a.status] - ORDER[b.status]) || a.name.localeCompare(b.name, 'de', { numeric: true }));
    const off = Number(sp.get('offset') ?? 0), lim = sp.has('limit') ? Number(sp.get('limit')) : undefined;
    return J({ summary, items: list.slice(off, lim === undefined ? undefined : off + lim), total: list.length });
  }
  if ((mm = p.match(/^\/api\/admin\/previews\/([0-9a-z]+)$/)) && m === 'DELETE') {
    const r = st.previews.find((x) => x.itemId === mm![1]);
    if (r) Object.assign(r, { status: 'missing', bytes: null, audioLang: null, error: null });
    return ok();
  }
  if (p === '/api/admin/previews/regenerate' && m === 'POST') {
    const r = st.previews.find((x) => x.itemId === body.itemId);
    if (r) Object.assign(r, { status: 'preparing', error: null });
    return ok();
  }
  if (p === '/api/admin/previews/regenerate-failed' && m === 'POST') {
    const failed = st.previews.filter((x) => x.status === 'failed');
    failed.forEach((x) => Object.assign(x, { status: 'preparing', error: null }));
    return J({ ok: true, count: failed.length });
  }
  if (p === '/api/admin/live' && m === 'GET') return J({ sessions: st.live });
  if (p === '/api/admin/live/stop' && m === 'POST') {
    const i = st.live.findIndex((l) => l.userId === body.userId && l.playSessionId === body.playSessionId);
    if (i < 0) return J({ error: 'not_found' }, 404);
    st.live.splice(i, 1);
    log('live.stop', body.userId);
    return ok();
  }

  // ---- operations ----
  if (p === '/api/admin/health' && m === 'GET') {
    st.healthCalls.push(sp.get('refresh') === '1' ? '?refresh=1' : '');
    if (sp.get('refresh') === '1' && st.healthRefreshed) { st.health = st.healthRefreshed; st.healthRefreshed = null; }
    return J(st.health);
  }
  if (p === '/api/admin/health/login' && m === 'GET') return J(st.loginCheck);
  if (p === '/api/admin/authentik/repair' && m === 'POST') {
    st.repairs.push(body ?? {});
    const reply = st.repairReply ?? { ok: true, steps: [{ id: 'check', state: 'ok' }, { id: 'serviceAccount', state: 'ok' }, { id: 'extraFlows', state: 'ok' }, { id: 'readback', state: 'ok' }], tokenSaved: true, check: loginCheckOk() };
    if (reply.check) st.loginCheck = reply.check;
    return J(reply);
  }
  if (p === '/api/admin/streams' && m === 'GET') return J(st.streams);
  if (p === '/api/admin/health/banner' && m === 'GET') {
    st.bannerCalls++;
    if (st.bannerFails) return J({ error: 'boom' }, 500);
    const issues = st.bannerIssues.filter((i) => st.dismissed[i.id] !== i.fp).sort((a, b) => (a.level === b.level ? a.id.localeCompare(b.id) : a.level === 'err' ? -1 : 1));
    return J({ issues, worst: issues.some((i) => i.level === 'err') ? 'err' : issues.length ? 'warn' : 'ok' });
  }
  if (p === '/api/admin/usage' && m === 'GET') {
    st.usageCalls.push(sp.toString());
    const days = Number(sp.get('days') ?? 30);
    if (![7, 30, 90].includes(days)) return J({ error: 'bad_request' }, 400);
    return J({ users: usageRows(st, days), since: st.usageSince });
  }
  if ((mm = p.match(/^\/api\/admin\/usage\/([^/]+)$/)) && m === 'GET') {
    st.usageDetailCalls.push(mm[1]!);
    if (!st.users.some((u) => u.id === mm![1])) return J({ error: 'not_found' }, 404);
    return J(usageDetail(mm[1]!, Number(sp.get('days') ?? 30)));
  }
  if (p === '/api/admin/hygiene/summary' && m === 'GET') return J(hygieneSummary(st.hygiene));
  if (p === '/api/admin/hygiene' && m === 'GET') return J(hygieneList(st.hygiene, sp));
  if (p === '/api/admin/hygiene/ignore' && (m === 'POST' || m === 'DELETE')) {
    const r = st.hygiene.items.find((x) => x.itemId === body.itemId);
    if (!r || !(body.code in HYG_CAT)) return J({ error: 'bad_request' }, 400);
    if (m === 'POST') st.hygiene.ignored.add(`${r.itemId}|${body.code}`); else st.hygiene.ignored.delete(`${r.itemId}|${body.code}`);
    log(m === 'POST' ? 'hygiene.ignore' : 'hygiene.unignore', r.itemId, { code: body.code });
    return ok();
  }
  if ((mm = p.match(/^\/api\/admin\/hygiene\/([\w-]+)\/refresh$/)) && m === 'POST') {
    if (!st.hygiene.canRefresh) return J({ error: 'unsupported' }, 501);
    st.hygiene.refreshed.push(mm[1]!);
    return ok();
  }
  if (p === '/api/admin/hygiene/scan' && m === 'POST') {
    st.hygiene.scans++;
    if (st.hygiene.running) return J({ started: false });
    st.hygiene.running = true;
    return J({ started: true });
  }
  if (p === '/api/admin/health/dismiss' && m === 'POST') {
    if (!/^[a-z]+:[a-zA-Z]+$/.test(body.id ?? '') || !/^[0-9a-f]{12}$/.test(body.fp ?? '')) return J({ error: 'bad_request' }, 400);
    st.dismissed[body.id] = body.fp;
    return ok();
  }
  if (p === '/api/admin/errors' && m === 'GET') return J(st.errors);
  if (p === '/api/admin/playback/timing' && m === 'GET') {
    // start-time measurements: remote phones load 6 s segments (the long-segment hint), the first fragment is the biggest step
    const pct = (p50: number | null, p90 = p50) => ({ p50, p90 });
    const g = (home: boolean, device: string | null, n: number, frag: number, td: number | null) => ({
      home, device, n, switches: home ? 0 : 1, total: pct(400 + 300 + frag + 200, 2 * (900 + frag)), targetDuration: td, seekP50: 800, stallsPerSession: home ? 0 : 0.5, stallMsPerSession: home ? 0 : 1200,
      phases: { info: pct(400, 900), manifest: pct(300, 600), firstFrag: pct(frag, frag * 2), firstFrame: pct(200, 400) },
    });
    const day = [g(true, null, 4, 600, 3), g(true, 'pc', 4, 600, 3), g(false, null, 3, 4200, 6), g(false, 'phone', 3, 4200, 6)];
    const row = (i: number, home: boolean, device: string, frame: number) => ({
      at: ago(i * 10), home, device, mode: 'hls', qualitySwitch: i === 2, bitrate: 8e6, targetDuration: home ? 3 : 6, infoMs: 400, manifestMs: 700, firstFragMs: frame - 200,
      firstFragBytes: 4_200_000, firstFragDlMs: frame - 1000, firstFrameMs: frame, seeks: 1, seekMedianMs: 800, seekMaxMs: 800, stalls: home ? 0 : 1, stallMs: home ? 0 : 2400, effectiveType: null,
    });
    return J({ day, week: day, recent: [row(1, false, 'phone', 5600), row(2, false, 'phone', 3100), row(3, true, 'pc', 1500)] });
  }
  if (p === '/api/admin/playback-check') {
    if (m === 'POST') return ok();
    return J({ running: false, done: 6, total: 6, startedAt: ago(3), finishedAt: ago(2), results: [{ itemId: 'a'.repeat(32), name: 'Kaputter Film', type: 'Movie', ok: false, status: 500, ms: 900, bytes: 0, error: 'HTTP 500 transcoder failed' }, ...Array.from({ length: 5 }, (_, i) => ({ itemId: String(i).repeat(32), name: 'Film ' + i, type: 'Movie', ok: true, status: 200, ms: 800 + i * 90, bytes: 1, error: null }))] });
  }
  if ((mm = p.match(/^\/api\/admin\/downloads\/([^/]+)$/)) && m === 'DELETE') { st.revokedLicences.push(mm[1]!); log('download.revoke', mm[1]!); return ok(); }
  if (p === '/api/admin/downloads') return J({ enabled: true, maxBytes: 50 * 1024 ** 3, diskBytes: 12.4 * 1024 ** 3, jobCounts: { ready: 3, preparing: 1 }, jobs: [{ id: auid(400), item_id: 'abcdef0123456789abcdef0123456789', title: 'Inkwell', series_name: null, quality: 'hd', audio_lang: 'deu', status: 'preparing', seg_done: 40, seg_total: 100, bytes: 1e9, error: null, created_at: ago(2), updated_at: ago(1), licenses: 2 }], licenses: [{ id: auid(401), user_name: 'Anna', device_label: 'iPhone', item_id: 'x', title: 'Inkwell', series_name: null, quality: 'hd', status: 'fetched', created_at: ago(30), expires_at: fut(500) }] });
  if ((mm = p.match(/^\/api\/admin\/downloads\/([^/]+)$/)) && m === 'DELETE') return ok();
  if (p === '/api/admin/digest') {
    if (m === 'PUT') return J({ enabled: body.enabled, day: body.day, hour: body.hour, source: 'admin', lastRun: null });
    return J({ enabled: true, day: 5, hour: 18, source: 'admin', lastRun: { week: '2026-W40', sentAt: ago(100), count: 9 } });
  }
  if (p === '/api/admin/digest/test' && m === 'POST') return J({ sent: 1 });
  if (p === '/api/admin/sources' && m === 'GET') return J({ sources: st.sources });
  if ((mm = p.match(/^\/api\/admin\/sources\/(tmdb|omdb)(\/test)?$/))) {
    const src = st.sources.find((x) => x.name === mm![1])!;
    if (mm[2]) {
      if (m !== 'POST') return null;
      if (!body?.key && !src.set) return J({ ok: false, error: 'not_set' });
      return J(body?.key?.includes('bad') || (!body?.key && src.invalid) ? { ok: false, error: 'invalid_key' } : { ok: true });
    }
    if (m === 'GET') return J(src);
    if (src.from === 'file') return J({ error: 'from_file' }, 409);
    if (m === 'PUT' && String(body.key).includes('boom')) return J({ error: 'server' }, 500);
    if (m === 'PUT' && (String(body.key).length < 8 || /\s/.test(String(body.key)))) return J({ error: 'invalid' }, 400);
    if (m === 'PUT') { Object.assign(src, { set: true, last4: String(body.key).slice(-4), from: 'db', invalid: false }); log('source.set', null, { name: src.name }); return J(src); }
    if (m === 'DELETE') { Object.assign(src, { set: false, last4: null, from: null, invalid: false }); log('source.remove', null, { name: src.name }); return J(src); }
  }
  if (p === '/api/admin/leaving' && m === 'GET') return J({ items: [...st.leaving].sort((a, b) => a.leavesAt.localeCompare(b.leavesAt)) });
  if ((mm = p.match(/^\/api\/admin\/leaving\/([0-9a-f]{32})$/))) {
    const id = mm[1]!;
    if (m === 'DELETE') { st.leaving = st.leaving.filter((r) => r.itemId !== id); log('leaving.clear', id); return ok(); }
    if (m === 'PUT') {
      if (body.leavesAt < leaveDay(0)) return J({ error: 'date_out_of_range' }, 400);
      const days = Math.round((new Date(body.leavesAt + 'T00:00').getTime() - new Date(leaveDay(0) + 'T00:00').getTime()) / 864e5);
      st.leaving = [...st.leaving.filter((r) => r.itemId !== id), { ...leavingRow(id, days, body.note ?? null), leavesAt: body.leavesAt }];
      log('leaving.set', id, { leavesAt: body.leavesAt });
      return J({ itemId: id, leavesAt: body.leavesAt, note: body.note ?? null });
    }
  }
  if (p === '/api/admin/update') {
    const UPDATE_RELEASE = {
      updateAvailable: true,
      release: { version: '1.1.0', codename: 'Arancini', tag: 'v1.1.0', name: 'v1.1.0 Arancini', url: 'https://example.org/releases/v1.1.0', publishedAt: ago(5), notes: '### Streaming\n- **Adaptive quality** for every <kbd>connection</kbd>\n- <img src=x onerror="window.__xss=1">Night mode\n\nThanks!' },
    };
    if (m === 'POST') return J({ ok: true, mode: 'webhook' }, 202);
    return J({ ...UPDATE_RELEASE, current: { sha: 'c0be6c5deadbeef', builtAt: ago(70), version: '1.0.0', codename: 'Arancini' }, latest: { sha: 'ff00aa1deadbeef', date: ago(5), runUrl: 'https://example.org/run' }, behind: 3, portainer: { configured: true, mode: 'webhook' }, autoUpdateNote: true, commits: [{ sha: 'ff00aa1', url: 'https://example.org/c/1', message: 'feat(wishes): local request-service users', author: 'Manu', date: ago(5) }, { sha: 'ee11bb2', url: 'https://example.org/c/2', message: 'ci: signing', author: 'Manu', date: ago(9) }] });
  }
  return null;
}
