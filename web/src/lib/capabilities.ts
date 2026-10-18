// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { writable } from 'svelte/store';

/**
 * What the media server behind FriendFlix supports (backend: media/types.ts, sent once in /api/me as `server.capabilities`).
 * UI for an unsupported feature is hidden. Until /api/me answers - and for older backends that send nothing - everything
 * counts as supported, so a Jellyfin instance looks exactly as before.
 */
export interface ServerCaps {
  /** skip-segment types (intro / outro / recap / preview) */
  segments: string[];
  trickplay: boolean;
  /** announced episodes (calendar) */
  upcoming: boolean;
  /** remote subtitle search in the player */
  subtitleSearch: boolean;
  webhooks: boolean;
  changeFeed: boolean;
  planB: boolean;
  /** subtitles come from FriendFlix itself (their URLs in the playback answer already point there; informational) */
  subtitleExtract: boolean;
  /** chapter marks on the seek bar + the player's "Szenen" panel (Block 17) */
  chapters: boolean;
  /** POST /api/playback/info may be prefetched on hover / focus (false: that call starts the server's transcode, e.g. Plex) */
  playbackPrefetch: boolean;
}

export const ALL_CAPS: ServerCaps = {
  segments: ['intro', 'outro', 'recap', 'preview'], trickplay: true, upcoming: true, subtitleSearch: true, webhooks: true, changeFeed: false, planB: true, subtitleExtract: false, chapters: true, playbackPrefetch: true,
};

/** Lenient parse: a missing or malformed field keeps its "supported" default. */
export function capsFrom(raw: unknown): ServerCaps {
  if (!raw || typeof raw !== 'object') return { ...ALL_CAPS, segments: [...ALL_CAPS.segments] };
  const r = raw as Record<string, unknown>;
  const flag = (k: Exclude<keyof ServerCaps, 'segments'>) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : ALL_CAPS[k]);
  return {
    segments: Array.isArray(r.segments) ? r.segments.filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase()) : [...ALL_CAPS.segments],
    trickplay: flag('trickplay'), upcoming: flag('upcoming'), subtitleSearch: flag('subtitleSearch'), webhooks: flag('webhooks'), changeFeed: flag('changeFeed'), planB: flag('planB'),
    subtitleExtract: flag('subtitleExtract'), chapters: flag('chapters'), playbackPrefetch: flag('playbackPrefetch'),
  };
}

export const serverCaps = writable<ServerCaps>(capsFrom(undefined));

/** a skip button / timeline mark for this segment type may show */
export const segmentShown = (c: ServerCaps, type: string) => c.segments.includes(type.toLowerCase());

/**
 * Optional services of this instance (sent in /api/me as `features`, not a media server capability). Until /api/me answers - and
 * for older backends that send nothing - everything counts as on.
 */
export interface Features {
  /** a request service is set up: wishes, upcoming titles (the /requests page keeps its reminders without it) */
  requests: boolean;
  /** 1.1 post-play screen (POSTPLAY_ENABLED): the "Done? See what's next" card, the end-of-title overlay and /postplay/:id */
  postplay: boolean;
}
export const ALL_FEATURES: Features = { requests: true, postplay: true };
/** Lenient parse: only an explicit false turns a feature off. */
export function featuresFrom(raw: unknown): Features {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { requests: r.requests !== false, postplay: r.postplay !== false };
}
export const features = writable<Features>(featuresFrom(undefined));

/** pages that only make sense with a capability or a feature (menus, footer, admin nav): href -> required flag */
const NEEDS: Record<string, Exclude<keyof ServerCaps, 'segments'>> = { '/calendar': 'upcoming' };
const FEATURE_NEEDS: Record<string, keyof Features> = { '/upcoming': 'requests', '/admin/requests': 'requests' };
export const linkShown = (c: ServerCaps, href: string, f: Features = ALL_FEATURES) => {
  const k = NEEDS[href], fk = FEATURE_NEEDS[href];
  return (!k || c[k]) && (!fk || f[fk]);
};
