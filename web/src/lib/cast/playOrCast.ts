// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Click handler for play links: while a cast session runs, a plain tap on Play sends the title to the TV and keeps the
 * user on the page. Without a session, with a modifier key / non-primary button, or when the click was already handled,
 * it does nothing and the link navigates to /watch/… as usual. Only call it for links that play a Movie / Episode.
 */
import { get } from 'svelte/store';
import { tr } from '#lib/i18n';
import { noteInteraction } from '#lib/stillwatching';
import { toast } from '#lib/ui/toast';
import { castEngine, castSession } from './engine';

export function playOrCast(e: MouseEvent, item: { id: string; positionTicks?: number }): boolean {
  const s = get(castSession);
  if (!s || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  e.preventDefault();
  noteInteraction(); // a tap: the viewer is there ("still watching?")
  void castEngine.playOnTv(item.id, item.positionTicks ? item.positionTicks / 10_000_000 : undefined);
  toast.info(tr('player.castBar.playingOn', { device: s.device }));
  return true;
}
