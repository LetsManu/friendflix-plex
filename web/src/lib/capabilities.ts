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
}

export const ALL_CAPS: ServerCaps = {
  segments: ['intro', 'outro', 'recap', 'preview'], trickplay: true, upcoming: true, subtitleSearch: true, webhooks: true, changeFeed: false, planB: true, subtitleExtract: false,
};

/** Lenient parse: a missing or malformed field keeps its "supported" default. */
export function capsFrom(raw: unknown): ServerCaps {
  if (!raw || typeof raw !== 'object') return { ...ALL_CAPS, segments: [...ALL_CAPS.segments] };
  const r = raw as Record<string, unknown>;
  const flag = (k: Exclude<keyof ServerCaps, 'segments'>) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : ALL_CAPS[k]);
  return {
    segments: Array.isArray(r.segments) ? r.segments.filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase()) : [...ALL_CAPS.segments],
    trickplay: flag('trickplay'), upcoming: flag('upcoming'), subtitleSearch: flag('subtitleSearch'), webhooks: flag('webhooks'), changeFeed: flag('changeFeed'), planB: flag('planB'),
    subtitleExtract: flag('subtitleExtract'),
  };
}

export const serverCaps = writable<ServerCaps>(capsFrom(undefined));

/** a skip button / timeline mark for this segment type may show */
export const segmentShown = (c: ServerCaps, type: string) => c.segments.includes(type.toLowerCase());

/** pages that only make sense with a capability (menus, footer): href -> required flag */
const NEEDS: Record<string, Exclude<keyof ServerCaps, 'segments'>> = { '/calendar': 'upcoming' };
export const linkShown = (c: ServerCaps, href: string) => { const k = NEEDS[href]; return !k || c[k]; };
