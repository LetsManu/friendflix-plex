// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Upstream, UpstreamCredentials } from './types.js';

const ID = '[0-9a-fA-F]{32}';

/** Jellyfin authorization header (the backend's Plan B variant lives in backend/src/jellyfin/client.ts). */
export function mediaBrowserHeader(deviceId: string, token: string) {
  const esc = (v: string) => v.replace(/["\\\r\n]/g, '');
  return `MediaBrowser Client="FriendFlix", Device="Gateway", DeviceId="${esc(deviceId)}", Version="0.1.0", Token="${esc(token)}"`;
}

export const jellyfinUpstream: Upstream = {
  kind: 'jellyfin',
  urlEnv: 'JELLYFIN_URL',
  paths: [
    new RegExp(`^/Videos/${ID}/(master|main)\\.m3u8$`),
    new RegExp(`^/Videos/${ID}/(hls1?|hls)/[\\w.-]+/[\\w.-]+$`),
    new RegExp(`^/Videos/${ID}/stream(\\.\\w{2,5})?$`),
    new RegExp(`^/Videos/${ID}/${ID}/Subtitles/\\d{1,3}/\\d{1,10}/Stream\\.(vtt|srt)$`),
    new RegExp(`^/Videos/${ID}/Trickplay/\\d{2,4}/\\d{1,5}\\.jpg$`),
    new RegExp(`^/Items/${ID}/Images/(Primary|Backdrop|Logo|Thumb|Banner|Chapter)(/\\d{1,3})?$`),
  ],
  // no /stream (direct download), no Trickplay, no Logo/Thumb/Banner/Chapter
  castPaths: [
    new RegExp(`^/Videos/${ID}/(master|main)\\.m3u8$`),
    new RegExp(`^/Videos/${ID}/(hls1?|hls)/[\\w.-]+/[\\w.-]+$`),
    new RegExp(`^/Videos/${ID}/${ID}/Subtitles/\\d{1,3}/\\d{1,10}/Stream\\.vtt$`),
    new RegExp(`^/Items/${ID}/Images/(Primary|Backdrop)$`),
  ],
  // every /stream request (static or not: Jellyfin can stream-copy)
  directStream: /^\/Videos\/[0-9a-fA-F]{32}\/stream(\.\w{2,5})?$/,
  image: /^\/Items\/[0-9a-fA-F]{32}\/Images\//,
  stripQuery: new Set(['api_key', 'apikey', 'x-emby-token', 'x-mediabrowser-token', 'token']),
  castDropQuery: new Set(['livestreamid', 'deviceid']),
  clampHeight: ['maxheight', 'height'],
  clampWidth: ['maxwidth', 'width'],
  clampBitrate: ['maxstreamingbitrate', 'videobitrate'],
  // HLS playlists and segments: Jellyfin falls back to the source bitrate (or stream copy) when these are missing
  requireBitrate: { path: new RegExp(`^/Videos/${ID}/((master|main)\\.m3u8|(hls1?|hls)/[\\w.-]+/[\\w.-]+)$`), params: ['MaxStreamingBitrate', 'VideoBitrate'] },
  authHeaders: (c: UpstreamCredentials) => ({ Authorization: mediaBrowserHeader(c.deviceId, c.token) }),
};
