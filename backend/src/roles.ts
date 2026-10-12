import { z } from 'zod';

export const roleTemplateSchema = z.object({
  label: z.string(),
  /** 'all' or library (media folder) names */
  libraries: z.union([z.literal('all'), z.array(z.string())]),
  /** Jellyfin MaxParentalRating (e.g. 12). null = unrestricted */
  maxParentalRating: z.number().int().nullable(),
  /** bits per second */
  maxBitrate: z.number().int().positive(),
  maxStreams: z.number().int().positive(),
  transcoding: z.boolean(),
  /** max video height in px (playback is capped/transcoded down to it). null = no cap */
  maxHeight: z.number().int().positive().nullable(),
  download: z.boolean(),
  /** max simultaneously active offline licenses per account */
  maxDownloads: z.number().int().min(0).max(200),
  /** max height of downloaded copies (0 = no downloads) */
  downloadMaxHeight: z.number().int().min(0).max(2160),
  /** validity of a license in days */
  downloadDays: z.number().int().min(1).max(90),
});
export type RoleTemplate = z.infer<typeof roleTemplateSchema>;

export const DEFAULT_ROLES: Record<string, RoleTemplate> = {
  friend: { label: 'Freund', libraries: 'all', maxParentalRating: null, maxBitrate: 20_000_000, maxStreams: 2, transcoding: true, maxHeight: null, download: false, maxDownloads: 15, downloadMaxHeight: 720, downloadDays: 30 },
  family: { label: 'Familie', libraries: 'all', maxParentalRating: null, maxBitrate: 40_000_000, maxStreams: 4, transcoding: true, maxHeight: null, download: true, maxDownloads: 25, downloadMaxHeight: 1080, downloadDays: 30 },
  guest: { label: 'Gast', libraries: 'all', maxParentalRating: 12, maxBitrate: 8_000_000, maxStreams: 1, transcoding: true, maxHeight: 1080, download: false, maxDownloads: 0, downloadMaxHeight: 0, downloadDays: 30 },
  admin: { label: 'Admin', libraries: 'all', maxParentalRating: null, maxBitrate: 60_000_000, maxStreams: 6, transcoding: true, maxHeight: null, download: true, maxDownloads: 50, downloadMaxHeight: 1080, downloadDays: 30 },
};

export const INVITABLE_ROLES = ['friend', 'family', 'guest'] as const;

export function loadRoles(overrideJson?: string): Record<string, RoleTemplate> {
  if (!overrideJson) return DEFAULT_ROLES;
  const o = z.record(z.string(), roleTemplateSchema.partial()).parse(JSON.parse(overrideJson));
  const out: Record<string, RoleTemplate> = { ...DEFAULT_ROLES };
  for (const [k, v] of Object.entries(o)) out[k] = { ...(DEFAULT_ROLES[k] ?? DEFAULT_ROLES.friend!), ...v } as RoleTemplate;
  return out;
}

export const MAX_HEIGHTS = [720, 1080, 1440, 2160] as const;
const TTL_MS = 30_000;
const cache = new WeakMap<object, { at: number; rows: Map<string, { transcoding: boolean | null; maxHeight: number | null; download: boolean | null; maxDownloads: number | null; downloadMaxHeight: number | null; downloadDays: number | null }> }>();

/** Code default <- ROLE_TEMPLATES env (ctx.roles) <- role_settings row (admin UI). Cached ~30 s per ctx; max_height 0 = unlimited. */
export async function effectiveRole(ctx: { roles: Record<string, RoleTemplate>; db: { query: (q: string) => Promise<{ rows: any[] }> } }, role: string): Promise<RoleTemplate | undefined> {
  const base = ctx.roles[role];
  if (!base) return undefined;
  let c = cache.get(ctx);
  if (!c || Date.now() - c.at > TTL_MS) {
    const r = await ctx.db.query('select role, transcoding, max_height, download, max_downloads, download_max_height, download_days from role_settings');
    c = { at: Date.now(), rows: new Map(r.rows.map((x) => [x.role as string, { transcoding: x.transcoding, maxHeight: x.max_height, download: x.download, maxDownloads: x.max_downloads, downloadMaxHeight: x.download_max_height, downloadDays: x.download_days }])) };
    cache.set(ctx, c);
  }
  const o = c.rows.get(role);
  if (!o) return base;
  return {
    ...base,
    transcoding: o.transcoding ?? base.transcoding,
    maxHeight: o.maxHeight === null ? base.maxHeight : o.maxHeight === 0 ? null : o.maxHeight,
    download: o.download ?? base.download,
    maxDownloads: o.maxDownloads ?? base.maxDownloads,
    downloadMaxHeight: o.downloadMaxHeight ?? base.downloadMaxHeight,
    downloadDays: o.downloadDays ?? base.downloadDays,
  };
}
export const invalidateRoles = (ctx: object) => void cache.delete(ctx);
