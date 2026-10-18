// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Admin → Update, channel part (backend/src/channel.ts): which channel the install runs, the selected one (setting
 * UPDATE_CHANNEL), and when to show the `.env` line plus the pull command. FriendFlix never touches Docker itself, so
 * switching always means: change FF_TAG in the stack's .env, then pull and restart.
 */
import type { BuildKind, Channel } from '#lib/version/build';

export const CHANNELS: readonly Channel[] = ['stable', 'nightly'];
/** the production stack (compose.prod.yaml); FF_TAG only exists there */
export const PULL_COMMAND = 'docker compose -f compose.prod.yaml -f compose.plex.yaml pull && docker compose -f compose.prod.yaml -f compose.plex.yaml up -d';

export interface ChannelInfo { selected: Channel; running: Channel | null; build: BuildKind | null; label: string; locked: boolean; envLine: string }
export interface ChannelState { updateAvailable?: boolean | null; behind?: number | null; channel?: ChannelInfo | null }

/** the `.env` line for a channel (compose.prod.yaml: image tag ${FF_TAG:-latest}) */
export const envLineFor = (c: Channel): string => `FF_TAG=${c === 'nightly' ? 'nightly' : 'latest'}`;

/** the snippet shows when the selection differs from what runs (a known channel), or when there is an update on the selection */
export function showSnippet(s: ChannelState): boolean {
  const ch = s.channel;
  if (!ch) return false;
  return (ch.running !== null && ch.running !== ch.selected) || s.updateAvailable === true;
}

/** "switch" when the selection differs from what runs, else "update" */
export const snippetReason = (s: ChannelState): 'switch' | 'update' =>
  s.channel && s.channel.running !== null && s.channel.running !== s.channel.selected ? 'switch' : 'update';

/** nothing newer on the selected channel (older backends without channel: the commit comparison) */
export function isUpToDate(s: ChannelState): boolean {
  if (s.updateAvailable === false) return true;
  return s.updateAvailable == null && s.behind === 0;
}

/** arrow-key target in the segmented switch (wraps) */
export function stepChannel(cur: Channel, key: string): Channel | null {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return null;
  const i = CHANNELS.indexOf(cur), d = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  return CHANNELS[(i + d + CHANNELS.length) % CHANNELS.length]!;
}
