import { z } from 'zod';
import type { MediaEvent } from '../media/types.js';

const normId = (s: string) => s.replace(/-/g, '').toLowerCase();

/** Payload of the Jellyfin webhook plugin template (docs/integrations.md). */
const jfWebhook = z.object({
  type: z.string(),
  user: z.string().optional(),
  itemId: z.string().transform(normId).optional(),
  name: z.string().optional(),
  seriesName: z.string().optional(),
  positionTicks: z.coerce.number().optional(),
  runtimeTicks: z.coerce.number().optional(),
  isPaused: z.union([z.boolean(), z.string()]).optional(),
  deviceName: z.string().optional(),
  itemType: z.string().optional(),
  provider_tmdb: z.union([z.string(), z.number()]).optional(),
  /** ItemAdded Episode: lets "Erinnere mich" match a replaced placeholder episode by series + season + number */
  seriesId: z.string().transform(normId).optional(),
  seasonNumber: z.union([z.string(), z.number()]).optional(),
  episodeNumber: z.union([z.string(), z.number()]).optional(),
});

const num = (v: string | number | undefined) => (v !== undefined && v !== '' && Number.isInteger(Number(v)) ? Number(v) : undefined);
const PLAYBACK: Record<string, 'start' | 'progress' | 'stop'> = { PlaybackStart: 'start', PlaybackProgress: 'progress', PlaybackStop: 'stop' };

/** Jellyfin webhook body -> neutral events ([] = nothing to do, null = malformed). */
export function jellyfinWebhookEvents(body: unknown): MediaEvent[] | null {
  const b = jfWebhook.safeParse(body);
  if (!b.success) return null;
  const e = b.data;
  if (e.type === 'ItemAdded' && e.itemId) {
    const tmdb = Number(e.provider_tmdb);
    return [{
      type: 'itemAdded', itemId: e.itemId, itemType: e.itemType ?? '',
      ...(Number.isInteger(tmdb) && tmdb > 0 ? { tmdbId: tmdb } : {}),
      ...(e.itemType === 'Episode'
        ? { seriesId: e.seriesId && /^[0-9a-f]{32}$/.test(e.seriesId) ? e.seriesId : undefined, season: num(e.seasonNumber), episode: num(e.episodeNumber) }
        : {}),
    }];
  }
  if (e.type === 'ItemDeleted' && e.itemId) return [{ type: 'itemRemoved', itemId: e.itemId, itemType: e.itemType }];
  const state = PLAYBACK[e.type];
  if (!state || !e.user || !e.itemId) return [];
  return [{
    type: 'playback', state, serverUserName: e.user, itemId: e.itemId, name: e.name, seriesName: e.seriesName,
    positionTicks: e.positionTicks, runtimeTicks: e.runtimeTicks, paused: e.isPaused === true || e.isPaused === 'True' || e.isPaused === 'true',
    device: e.deviceName ?? 'dev',
  }];
}
