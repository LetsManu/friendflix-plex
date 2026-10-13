import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { Where, likePattern, orderBy, pageQuery } from '../adminlist.js';
import type { Ctx } from '../ctx.js';
import { revokeSessions } from '../devices.js';
import { adminOverview, revokeLicense } from '../downloads.js';
import { createInvite, deleteAuthentikInvitation } from '../invites.js';
import { checkState, startPlaybackCheck } from '../healthcheck.js';
import { clipPath, libraryItems, previews, serviceUser } from '../previews.js';
import { stat } from 'node:fs/promises';
import { defaultLimit } from '../requestlimit.js';
import { DEFAULT_ROLES, INVITABLE_ROLES, effectiveRole, invalidateRoles } from '../roles.js';
import { requireGrownUp } from '../kids.js';
import { requireAdmin, requireOwner } from '../session.js';
import { portainerMode, triggerUpdate, updateInfo } from '../updates.js';
import { MAX_FEATURED } from '../lists.js';
import { accountJellyfinIds } from '../profiles.js';
import { applyRole, getUserById, reapplyRole } from '../users.js';
import { FALLBACK_LANGUAGE, LANGUAGES, instanceLanguage, isLanguage, roleLabel, setInstanceLanguage } from '../i18n.js';

const uuid = z.guid();

export function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  const admin = { preHandler: requireAdmin(ctx) };

  app.get('/api/admin/status', admin, async () => {
    const { listLive } = await import('../live.js');
    const { parties } = await import('./party.js');
    const n = async (sql: string) => Number((await ctx.db.query<{ n: string }>(sql)).rows[0]?.n ?? 0);
    return {
      users: await n('select count(*) n from users where not disabled'),
      pendingDevices: await n('select count(*) n from devices where not approved'),
      openInvites: await n('select count(*) n from invites where used_at is null and expires_at > now()'),
      pendingPolls: await n("select count(*) n from polls where status='needs_approval'"),
      activeStreams: (await listLive(ctx)).length,
      partyRooms: parties.rooms.size,
      jellyfin: await ctx.jf.admin.ping(),
    };
  });

  // one cheap call for the admin shell (pending badges) and the overview: counts only, every source optional
  app.get('/api/admin/summary', admin, async () => {
    const { listLive } = await import('../live.js');
    const { parties } = await import('./party.js');
    const one = async <T>(sql: string): Promise<T> => (await ctx.db.query(sql)).rows[0] as T;
    const [users, devices, invites, polls, previews, downloads, check, seerr, jellyfin, live] = await Promise.all([
      one<{ total: string; locked: string }>('select count(*) total, count(*) filter (where disabled) locked from users'),
      one<{ n: string }>('select count(*) n from devices where not approved'),
      one<{ n: string }>('select count(*) n from invites where used_at is null and expires_at > now()'),
      one<{ n: string }>("select count(*) n from polls where status='needs_approval'"),
      one<{ failed: string; ok: string; bytes: string }>("select count(*) filter (where status='failed') failed, count(*) filter (where status='ok') ok, coalesce(sum(bytes) filter (where status='ok'),0)::text bytes from preview_clips"),
      one<{ bytes: string }>("select coalesce(sum(bytes),0)::text bytes from download_jobs where status='ready'"),
      ctx.db.query<{ finished_at: Date; results: Array<{ ok: boolean }> }>('select finished_at, results from playback_checks order by id desc limit 1').then((r) => r.rows[0] ?? null),
      ctx.seerr.requestCount().catch(() => null), // Seerr down or not configured: the UI shows "not reachable"
      ctx.jf.admin.ping().catch(() => false),
      listLive(ctx).then((l) => l.length).catch(() => 0),
    ]);
    const total = Number(users.total), locked = Number(users.locked);
    return {
      users: { total, active: total - locked, locked },
      pending: {
        requests: seerr ? seerr.pending : null,
        devices: Number(devices.n),
        polls: Number(polls.n),
        invites: Number(invites.n),
        previewsFailed: Number(previews.failed),
      },
      requests: seerr ? { pending: seerr.pending, approved: seerr.approved, processing: seerr.processing, available: seerr.available, declined: seerr.declined, total: seerr.total } : null,
      storage: {
        downloadsEnabled: ctx.cfg.DOWNLOADS_ENABLED === 'true',
        downloadsBytes: Number(downloads.bytes),
        downloadsMaxBytes: Math.round(ctx.cfg.DOWNLOAD_CACHE_MAX_GB * 1024 ** 3),
        previewBytes: Number(previews.bytes),
        previewClips: Number(previews.ok),
      },
      playbackCheck: check ? { finishedAt: check.finished_at.toISOString(), total: check.results.length, failed: check.results.filter((x) => !x.ok).length } : null,
      services: { jellyfin: Boolean(jellyfin), seerr: seerr !== null },
      live: { streams: live, partyRooms: parties.rooms.size },
    };
  });

  app.post('/api/admin/previews/regenerate', admin, async (req) => {
    const { itemId } = z.object({ itemId: z.string().regex(/^[0-9a-f]{32}$/) }).parse(req.body);
    await previews(ctx).regenerate(itemId);
    await audit(ctx, req.user!.id, 'preview.regenerate', itemId);
    return { ok: true };
  });

  app.post('/api/admin/previews/regenerate-failed', admin, async () => ({ ok: true, count: await previews(ctx).regenerateFailed() }));

  // The library listing is a crawl through Jellyfin: short memo so paging/filtering/polling do not repeat it.
  const libMemo = { at: 0, rows: [] as Array<{ id: string; name: string; type: string }> };
  const library = async () => {
    if (Date.now() - libMemo.at > 15_000) {
      const user = await serviceUser(ctx);
      libMemo.rows = user ? await libraryItems(ctx, user) : [];
      libMemo.at = Date.now();
    }
    return libMemo.rows;
  };
  const PREVIEW_ORDER = { failed: 0, preparing: 1, missing: 2, ok: 3 } as const;
  // Without params: every title (legacy). ?status=failed|preparing|missing|ok &q= &sort=name|status|size &dir= &limit= &offset= pages the list server-side
  // (response adds `total` = matching rows); ?ids=a,b,c answers only those titles (the page polls rows that are being prepared).
  app.get('/api/admin/previews', admin, async (req) => {
    const p = z.object({
      status: z.enum(['failed', 'preparing', 'missing', 'ok']).optional(),
      q: z.string().trim().max(100).optional(),
      sort: z.enum(['name', 'status', 'size']).optional(),
      dir: z.enum(['asc', 'desc']).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
      ids: z.string().max(4000).optional(),
    }).parse(req.query);
    const lib = await library();
    const clips = new Map((await ctx.db.query<{ item_id: string; status: string; bytes: number | null; error: string | null; audio_lang: string | null; created_at: Date }>('select * from preview_clips')).rows.map((r) => [r.item_id, r]));
    const queued = new Set(previews(ctx).queued());
    const rows = await Promise.all(lib.map(async (i) => {
      const c = clips.get(i.id);
      let status: 'ok' | 'failed' | 'missing' | 'preparing' = 'missing';
      if (queued.has(i.id)) status = 'preparing';
      else if (c?.status === 'failed') status = 'failed';
      else if (c?.status === 'ok' && (await stat(clipPath(ctx, i.id)).then((s) => s.isFile(), () => false))) status = 'ok';
      return { itemId: i.id, name: i.name, type: i.type, status, bytes: status === 'ok' ? c?.bytes ?? null : null, audioLang: status === 'ok' ? c?.audio_lang ?? null : null, error: status === 'failed' ? c?.error ?? null : null, createdAt: c?.created_at ?? null };
    }));
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    const summary = { total: rows.length, ok: count('ok'), failed: count('failed'), missing: count('missing'), preparing: count('preparing'), totalBytes: rows.reduce((a, r) => a + (r.bytes ?? 0), 0) };
    const paged = p.limit !== undefined || p.ids !== undefined || p.status !== undefined || p.q !== undefined || p.sort !== undefined;
    if (!paged) return { summary, items: [...rows].sort((a, b) => PREVIEW_ORDER[a.status] - PREVIEW_ORDER[b.status] || a.name.localeCompare(b.name)) };
    let list = rows;
    if (p.ids !== undefined) { const want = new Set(p.ids.split(',').filter(Boolean)); list = list.filter((r) => want.has(r.itemId)); }
    if (p.status) list = list.filter((r) => r.status === p.status);
    if (p.q) { const q = p.q.toLocaleLowerCase(); list = list.filter((r) => r.name.toLocaleLowerCase().includes(q)); }
    const sign = p.dir === 'desc' ? -1 : 1;
    const by = {
      name: (a: (typeof rows)[number], b: (typeof rows)[number]) => sign * a.name.localeCompare(b.name),
      status: (a: (typeof rows)[number], b: (typeof rows)[number]) => sign * (PREVIEW_ORDER[a.status] - PREVIEW_ORDER[b.status]) || a.name.localeCompare(b.name),
      size: (a: (typeof rows)[number], b: (typeof rows)[number]) => sign * ((a.bytes ?? -1) - (b.bytes ?? -1)) || a.name.localeCompare(b.name),
    }[p.sort ?? 'status'];
    list = [...list].sort(by);
    return { summary, items: list.slice(p.offset, p.limit === undefined ? undefined : p.offset + p.limit), total: list.length };
  });

  // removes a clip (and its failure marker): frees the space, the warmer rebuilds it later
  app.delete('/api/admin/previews/:itemId', admin, async (req, reply) => {
    const itemId = z.string().regex(/^[0-9a-f]{32}$/).safeParse((req.params as { itemId: string }).itemId);
    if (!itemId.success) return reply.code(404).send({ error: 'not_found' });
    await previews(ctx).clear(itemId.data);
    libMemo.at = 0;
    await audit(ctx, req.user!.id, 'preview.clear', itemId.data);
    return { ok: true };
  });

  // playing right now (portal + Jellyfin sessions the portal knows about); the admin can end a stream
  app.get('/api/admin/live', admin, async () => {
    const { listLive } = await import('../live.js');
    const rows = (await listLive(ctx)).sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      sessions: rows.map((l) => ({
        userId: l.userId, userName: l.userName, profileName: l.profileName ?? null, playSessionId: l.playSessionId, itemId: l.itemId, title: l.title, seriesName: l.seriesName ?? null,
        type: l.type ?? null, positionTicks: l.positionTicks, runtimeTicks: l.runtimeTicks ?? null, isPaused: l.isPaused, updatedAt: new Date(l.updatedAt).toISOString(), source: l.source,
      })),
    };
  });
  app.post('/api/admin/live/stop', admin, async (req, reply) => {
    const b = z.object({ userId: uuid, playSessionId: z.string().min(1).max(200) }).parse(req.body);
    const { getLive, clearLive } = await import('../live.js');
    const live = await getLive(ctx, b.userId, b.playSessionId);
    if (!live) return reply.code(404).send({ error: 'not_found' });
    const user = await getUserById(ctx, b.userId);
    // ends the server-side transcode, the player then fails and shows its error; a direct-play file cannot be interrupted from here
    if (user) await ctx.jf.stopEncoding(user, b.playSessionId).catch(() => undefined);
    await clearLive(ctx, b.userId, b.playSessionId);
    await audit(ctx, req.user!.id, 'live.stop', b.userId, { title: live.title });
    return { ok: true };
  });

  // ---- instance default UI language (asked once on the first admin visit; profiles may override it) ----
  app.get('/api/admin/settings/language', admin, async () => {
    const l = await instanceLanguage(ctx);
    return { language: l ?? FALLBACK_LANGUAGE, set: l !== null, languages: LANGUAGES };
  });
  app.put('/api/admin/settings/language', admin, async (req) => {
    const { language } = z.object({ language: z.enum(LANGUAGES) }).parse(req.body);
    const before = await instanceLanguage(ctx);
    await setInstanceLanguage(ctx, language);
    if (before !== language) await audit(ctx, req.user!.id, 'settings.language', undefined, { from: before, to: language });
    return { language, set: true };
  });

  app.get('/api/admin/update', admin, async (req) => updateInfo(ctx, (req.query as { refresh?: string }).refresh === '1'));

  // one redeploy per 2 minutes for the whole portal (not per IP): a double click or a second admin must not restart the stack twice
  app.post('/api/admin/update', { ...admin, config: { rateLimit: { max: 1, timeWindow: '2 minutes', keyGenerator: () => 'update' } } }, async (req, reply) => {
    const mode = portainerMode(ctx);
    if (!mode) return reply.code(409).send({ error: 'not_configured' });
    const info = await updateInfo(ctx);
    await audit(ctx, req.user!.id, 'system.update', undefined, { from: info.current.sha, to: info.latest?.sha ?? null, fromVersion: info.current.version, toVersion: info.release?.version ?? null, mode });
    const r = await triggerUpdate(ctx, mode);
    if (!r.ok) {
      req.log.error({ mode, step: r.step, status: r.status, error: r.error, code: r.code }, 'portainer update failed');
      return reply.code(502).send({ error: r.error, status: r.status, step: r.step, ...(r.code ? { code: r.code } : {}) });
    }
    return reply.code(202).send({ ok: true, mode });
  });

  app.post('/api/admin/playback-check', admin, async (_req, reply) => {
    if (!(await startPlaybackCheck(ctx))) return reply.code(409).send({ error: 'already_running' });
    return { ok: true };
  });
  app.get('/api/admin/playback-check', admin, async () => checkState(ctx));

  // `roles`/`invitable` feed the users page; `limits` is the per-role monthly Seerr wish limit (null = unlimited) plus playback settings (transcoding, maxHeight null = unlimited)
  app.get('/api/admin/roles', admin, async () => {
    invalidateRoles(ctx);
    const set = new Map((await ctx.db.query<{ role: string; requests_per_month: number | null }>('select role, requests_per_month from role_settings')).rows.map((r) => [r.role, r.requests_per_month]));
    const remoteSet = new Set((await ctx.db.query<{ role: string }>('select role from role_settings where remote_max_bitrate is not null')).rows.map((r) => r.role));
    // builtinLabel: the label is the built-in (German) default of that role → the web app shows its translation; a label
    // renamed via ROLES_JSON is shown as configured (same rule as roleLabel() in /api/me and /api/invite)
    const builtin = (k: string, label: string) => Boolean(DEFAULT_ROLES[k] && DEFAULT_ROLES[k]!.label === label);
    const roles = Object.fromEntries(await Promise.all(Object.keys(ctx.roles).map(async (k) => { const r = (await effectiveRole(ctx, k))!; return [k, { ...r, builtinLabel: builtin(k, r.label) }] as const; })));
    const limits = Object.entries(roles).map(([role, t]) => ({ role, label: t.label, builtinLabel: t.builtinLabel, requestsPerMonth: set.has(role) ? set.get(role)! : defaultLimit(role), isDefault: !set.has(role), transcoding: t.transcoding, maxHeight: t.maxHeight, download: t.download, maxDownloads: t.maxDownloads, downloadMaxHeight: t.downloadMaxHeight, downloadDays: t.downloadDays, maxBitrate: t.maxBitrate, remoteMaxBitrate: t.remoteMaxBitrate, remoteDefault: ctx.roles[role]!.remoteMaxBitrate, remoteIsDefault: !remoteSet.has(role) }));
    return { roles, invitable: INVITABLE_ROLES, limits };
  });

  app.put('/api/admin/roles/:role', admin, async (req, reply) => {
    const role = (req.params as { role: string }).role;
    if (!Object.hasOwn(ctx.roles, role)) return reply.code(404).send({ error: 'not_found' });
    const b = z.object({
      requestsPerMonth: z.number().int().min(0).max(100).nullable().optional(),
      transcoding: z.boolean().optional(),
      maxHeight: z.number().int().min(144).max(4320).nullable().optional(), // null = unlimited
      download: z.boolean().optional(),
      maxDownloads: z.number().int().min(0).max(200).optional(),
      downloadMaxHeight: z.number().int().min(0).max(2160).optional(), // 0 = no downloads
      downloadDays: z.number().int().min(1).max(90).optional(),
      remoteMaxBitrate: z.number().int().min(300_000).max(200_000_000).nullable().optional(), // bit/s outside the home networks; null = back to the role default
    }).parse(req.body);
    const before = await effectiveRole(ctx, role);
    const cur = (await ctx.db.query<{ requests_per_month: number | null }>('select requests_per_month from role_settings where role=$1', [role])).rows[0];
    const limit = b.requestsPerMonth !== undefined ? b.requestsPerMonth : cur ? cur.requests_per_month : defaultLimit(role);
    await ctx.db.query(
      `insert into role_settings(role, requests_per_month, transcoding, max_height, download, max_downloads, download_max_height, download_days, remote_max_bitrate) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (role) do update set requests_per_month=$2, transcoding=coalesce($3, role_settings.transcoding), max_height=coalesce($4, role_settings.max_height),
         download=coalesce($5, role_settings.download), max_downloads=coalesce($6, role_settings.max_downloads), download_max_height=coalesce($7, role_settings.download_max_height),
         download_days=coalesce($8, role_settings.download_days), remote_max_bitrate=case when $10 then null else coalesce($9, role_settings.remote_max_bitrate) end, updated_at=now()`,
      [role, limit, b.transcoding ?? null, b.maxHeight === undefined ? null : (b.maxHeight ?? 0), b.download ?? null, b.maxDownloads ?? null, b.downloadMaxHeight ?? null, b.downloadDays ?? null, b.remoteMaxBitrate ?? null, b.remoteMaxBitrate === null],
    );
    invalidateRoles(ctx);
    const after = (await effectiveRole(ctx, role))!;
    if (b.requestsPerMonth !== undefined) await audit(ctx, req.user!.id, 'role.request_limit', role, { requestsPerMonth: b.requestsPerMonth });
    if (after.remoteMaxBitrate !== before?.remoteMaxBitrate) await audit(ctx, req.user!.id, 'role.remote_cap', role, { remoteMaxBitrate: after.remoteMaxBitrate });
    const dlChanged = after.download !== before?.download || after.maxDownloads !== before?.maxDownloads || after.downloadMaxHeight !== before?.downloadMaxHeight || after.downloadDays !== before?.downloadDays;
    if (dlChanged) await audit(ctx, req.user!.id, 'role.downloads', role, { download: after.download, maxDownloads: after.maxDownloads, downloadMaxHeight: after.downloadMaxHeight, downloadDays: after.downloadDays });
    if (after.transcoding !== before?.transcoding || after.maxHeight !== before?.maxHeight || after.download !== before?.download) {
      if (after.transcoding !== before?.transcoding || after.maxHeight !== before?.maxHeight) await audit(ctx, req.user!.id, 'role.playback', role, { transcoding: after.transcoding, maxHeight: after.maxHeight });
      const failed = await reapplyRole(ctx, role); // push the new policy to existing Jellyfin accounts
      if (failed) return reply.code(502).send({ error: 'policy_partial', failed });
    }
    return { ok: true };
  });

  // ?q= (name/email/login) &role= &status=active|locked &sort=name|email|role|status|lastSeen|createdAt &dir= &limit= &offset=; without params: everyone (max 1000)
  app.get('/api/admin/users', admin, async (req) => {
    const p = pageQuery.extend({ role: z.string().max(40).optional(), status: z.enum(['active', 'locked']).optional() }).parse(req.query);
    const w = new Where();
    if (p.q) { const m = w.param(likePattern(p.q)); w.add(`(u.name ilike ${m} or coalesce(u.email,'') ilike ${m} or coalesce(u.jellyfin_username,'') ilike ${m})`); }
    if (p.role) w.add('u.role = ?', p.role);
    if (p.status) w.add(p.status === 'locked' ? 'u.disabled' : 'not u.disabled');
    const order = orderBy({ name: 'lower(u.name)', email: "lower(coalesce(u.email,''))", role: 'u.role', status: 'u.disabled', lastSeen: 'u.last_seen', createdAt: 'u.created_at' }, p.sort, p.dir, 'u.created_at, u.id');
    const total = Number((await ctx.db.query<{ c: string }>(`select count(*) c from users u ${w.sql}`, w.params)).rows[0]!.c);
    const r = await ctx.db.query(
      `select * from (select u.id, u.name, u.email, u.role, u.disabled, u.jellyfin_username, u.seerr_user_id, u.created_at,
              (select max(last_seen) from devices d where d.user_id = u.id) last_seen from users u) u
        ${w.sql} ${order} limit ${p.limit ?? 1000} offset ${p.offset ?? 0}`,
      w.params,
    );
    return { users: r.rows, total };
  });

  app.patch('/api/admin/users/:id', admin, async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const b = z.object({ role: z.string().optional(), disabled: z.boolean().optional() }).parse(req.body);
    const user = await getUserById(ctx, id);
    if (!user) return reply.code(404).send({ error: 'not_found' });
    if (id === req.user!.id && (b.disabled || (b.role && b.role !== 'admin'))) return reply.code(400).send({ error: 'cannot_lock_yourself_out' });
    if (b.role && b.role !== user.role) {
      if (!Object.hasOwn(ctx.roles, b.role)) return reply.code(400).send({ error: 'unknown_role' });
      const ids = await accountJellyfinIds(ctx, id);
      const hidden = new Set(ids.filter((x) => x !== user.jellyfin_user_id));
      for (const jid of ids) await applyRole(ctx, jid, b.role, b.disabled ?? user.disabled, { hidden: hidden.has(jid) }); // re-apply template to the Jellyfin account and all its profile users
      await ctx.db.query('update users set role=$1 where id=$2', [b.role, id]);
      await audit(ctx, req.user!.id, 'user.role', id, { from: user.role, to: b.role });
    }
    if (b.disabled !== undefined && b.disabled !== user.disabled) {
      for (const jid of await accountJellyfinIds(ctx, id)) await ctx.jf.admin.setDisabled(jid, b.disabled);
      await ctx.db.query('update users set disabled=$1 where id=$2', [b.disabled, id]);
      if (b.disabled) await revokeSessions(ctx, id); // also revokes the account's offline licenses
      await audit(ctx, req.user!.id, b.disabled ? 'user.disable' : 'user.enable', id);
    }
    return { ok: true };
  });

  app.post('/api/admin/users/:id/revoke-sessions', admin, async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const n = await revokeSessions(ctx, id);
    await audit(ctx, req.user!.id, 'user.revoke_sessions', id, { sessions: n });
    return { revoked: n };
  });

  // ---- offline downloads: prepared jobs, disk usage, active licenses ----
  app.get('/api/admin/downloads', admin, async () => ({ enabled: ctx.cfg.DOWNLOADS_ENABLED === 'true', maxBytes: Math.round(ctx.cfg.DOWNLOAD_CACHE_MAX_GB * 1024 ** 3), ...(await adminOverview(ctx)) }));
  app.delete('/api/admin/downloads/:id', admin, async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    if (!(await revokeLicense(ctx, id))) return reply.code(404).send({ error: 'not_found' });
    await audit(ctx, req.user!.id, 'download.revoke', id);
    return { ok: true };
  });

  app.post('/api/admin/invites', admin, async (req) => {
    const b = z.object({
      role: z.enum(INVITABLE_ROLES),
      ttlHours: z.number().int().min(1).max(24 * 14).default(48),
      note: z.string().max(100).optional(),
      /** false: the person already has an Authentik account, skip enrollment */
      enroll: z.boolean().default(true),
    }).parse(req.body);
    const inv = await createInvite(ctx, req.user!.id, b, req.log);
    await audit(ctx, req.user!.id, 'invite.create', inv.id, { role: b.role, authentik: inv.authentik });
    return { id: inv.id, link: inv.link, enrollUrl: inv.enrollUrl, authentik: inv.authentik, expiresAt: inv.expiresAt }; // token is shown exactly once
  });

  // ?q= (note/role/redeemer) &status=open|used|expired &sort=role|note|validUntil|status|createdAt &dir= &limit= &offset=; without params: the newest 100
  app.get('/api/admin/invites', admin, async (req) => {
    const p = pageQuery.extend({ status: z.enum(['open', 'used', 'expired']).optional(), role: z.string().max(40).optional() }).parse(req.query);
    const w = new Where();
    if (p.q) { const m = w.param(likePattern(p.q)); w.add(`(coalesce(i.note,'') ilike ${m} or i.role ilike ${m} or coalesce(u.name,'') ilike ${m})`); }
    if (p.role) w.add('i.role = ?', p.role);
    if (p.status === 'used') w.add('i.used_at is not null');
    else if (p.status === 'expired') w.add('i.used_at is null and i.expires_at < now()');
    else if (p.status === 'open') w.add('i.used_at is null and i.expires_at >= now()');
    const order = orderBy({ role: 'i.role', note: "lower(coalesce(i.note,''))", validUntil: 'i.expires_at', createdAt: 'i.created_at', status: "(case when i.used_at is not null then 2 when i.expires_at < now() then 1 else 0 end)" }, p.sort, p.dir, 'i.created_at desc, i.id');
    const from = 'from invites i left join users u on u.id = i.used_by';
    const total = Number((await ctx.db.query<{ c: string }>(`select count(*) c ${from} ${w.sql}`, w.params)).rows[0]!.c);
    const r = await ctx.db.query(
      `select i.id, i.role, i.note, i.created_at, i.expires_at, i.used_at, u.name used_by_name ${from} ${w.sql} ${order} limit ${p.limit ?? 100} offset ${p.offset ?? 0}`,
      w.params,
    );
    return { invites: r.rows, total };
  });

  app.delete('/api/admin/invites/:id', admin, async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const r = await ctx.db.query<{ authentik_invite: string | null }>('delete from invites where id=$1 and used_at is null returning authentik_invite', [id]);
    await deleteAuthentikInvitation(ctx, r.rows[0]?.authentik_invite, req.log);
    await audit(ctx, req.user!.id, 'invite.revoke', id);
    return { ok: true };
  });

  // ?q= (list or owner name) &featured=1 &limit= &offset=; without params the newest 200 lists (legacy). `total` = matching lists, `featuredCount` = lists shown on the home page.
  app.get('/api/admin/lists', admin, async (req) => {
    const p = z.object({
      q: z.string().trim().max(100).optional(),
      featured: z.enum(['1', '0']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(200),
      offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
    }).parse(req.query);
    const params: unknown[] = [];
    const where: string[] = [];
    if (p.q) { params.push(`%${p.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`); where.push(`(l.name ilike $${params.length} or o.name ilike $${params.length})`); }
    if (p.featured) where.push(p.featured === '1' ? 'l.featured_at is not null' : 'l.featured_at is null');
    const w = where.length ? `where ${where.join(' and ')}` : '';
    const total = Number((await ctx.db.query<{ c: string }>(`select count(*) c from lists l join users o on o.id = l.owner_id ${w}`, params)).rows[0]!.c);
    const featuredCount = Number((await ctx.db.query<{ c: string }>('select count(*) c from lists where featured_at is not null')).rows[0]!.c);
    const r = await ctx.db.query<{ id: string; name: string; owner_id: string; owner_name: string; item_count: string; featured: boolean }>(
      `select l.id, l.name, l.owner_id, o.name as owner_name, (select count(*) from list_items i where i.list_id = l.id) as item_count, l.featured_at is not null as featured
         from lists l join users o on o.id = l.owner_id ${w} order by l.featured_at desc nulls last, l.created_at desc limit ${p.limit} offset ${p.offset}`, params);
    return { lists: r.rows.map((x) => ({ id: x.id, name: x.name, owner: { id: x.owner_id, name: x.owner_name }, itemCount: Number(x.item_count), featured: x.featured })), total, featuredCount, max: MAX_FEATURED };
  });

  app.put('/api/admin/lists/:id/featured', admin, async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    const b = z.object({ featured: z.boolean() }).parse(req.body);
    if (!id.success) return reply.code(404).send({ error: 'not_found' });
    const cur = (await ctx.db.query<{ featured: boolean }>('select featured_at is not null as featured from lists where id = $1', [id.data])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (b.featured && !cur.featured) {
      const n = Number((await ctx.db.query<{ c: string }>('select count(*) c from lists where featured_at is not null')).rows[0]!.c);
      if (n >= MAX_FEATURED) return reply.code(409).send({ error: 'too_many_featured' });
    }
    if (b.featured !== cur.featured) {
      await ctx.db.query('update lists set featured_at = case when $2::boolean then now() else null end where id = $1', [id.data, b.featured]);
      await audit(ctx, req.user!.id, b.featured ? 'list.feature' : 'list.unfeature', id.data);
    }
    return { ok: true, featured: b.featured };
  });

  // ?actor=<user id>|system &action=<category ("user") or full action ("user.role")> &from=&to= (ISO times) &q= (actor/target/action) &dir=asc|desc &limit= (default 100) &offset=
  app.get('/api/admin/audit', admin, async (req) => {
    const p = pageQuery.extend({
      actor: z.union([uuid, z.literal('system')]).optional(),
      action: z.string().regex(/^[a-z_]+(\.[a-z_]+)?$/).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    }).parse(req.query);
    const w = new Where();
    if (p.actor === 'system') w.add('a.actor is null');
    else if (p.actor) w.add('a.actor = ?', p.actor);
    if (p.action?.includes('.')) w.add('a.action = ?', p.action);
    else if (p.action) { const exact = w.param(p.action), prefix = w.param(`${p.action}.%`); w.add(`(a.action = ${exact} or a.action like ${prefix})`); }
    if (p.from) w.add('a.at >= ?', p.from);
    if (p.to) w.add('a.at <= ?', p.to);
    if (p.q) { const m = w.param(likePattern(p.q)); w.add(`(a.action ilike ${m} or coalesce(u.name,'') ilike ${m} or coalesce(tu.name, tl.name, '') ilike ${m})`); }
    // target_name: the user (or list) the target id points to, so the UI can say "… locked Anna" instead of a uuid
    const from = `from audit_log a left join users u on u.id = a.actor
         left join users tu on tu.id::text = a.target left join lists tl on tl.id::text = a.target`;
    const total = Number((await ctx.db.query<{ c: string }>(`select count(*) c ${from} ${w.sql}`, w.params)).rows[0]!.c);
    const r = await ctx.db.query(
      `select a.id, a.at, a.action, a.target, a.meta, a.actor actor_id, u.name actor, coalesce(tu.name, tl.name) target_name ${from} ${w.sql}
        order by a.id ${p.dir === 'asc' ? 'asc' : 'desc'} limit ${p.limit ?? 100} offset ${p.offset ?? 0}`,
      w.params,
    );
    return { entries: r.rows, total };
  });

  // options of the audit filters: people who acted and the action groups that occur
  app.get('/api/admin/audit/filters', admin, async () => {
    const actors = (await ctx.db.query<{ id: string; name: string }>('select distinct u.id, u.name from audit_log a join users u on u.id = a.actor order by u.name')).rows;
    const system = Number((await ctx.db.query<{ c: string }>('select count(*) c from (select 1 from audit_log where actor is null limit 1) x')).rows[0]!.c) > 0;
    const categories = (await ctx.db.query<{ c: string }>("select distinct split_part(action, '.', 1) c from audit_log order by 1")).rows.map((x) => x.c);
    return { actors, system, categories };
  });

  // ?q= (person/device) &status=pending|approved &sort=user|device|lastSeen|status &dir= &limit= (default 300) &offset=; `pending` = all waiting devices (badge), whatever the filter
  app.get('/api/admin/devices', admin, async (req) => {
    const p = pageQuery.extend({ status: z.enum(['pending', 'approved']).optional() }).parse(req.query);
    const w = new Where();
    if (p.q) { const m = w.param(likePattern(p.q)); w.add(`(u.name ilike ${m} or coalesce(d.label,'') ilike ${m})`); }
    if (p.status) w.add(p.status === 'pending' ? 'not d.approved' : 'd.approved');
    const order = orderBy({ user: 'lower(u.name)', device: "lower(coalesce(d.label,''))", lastSeen: 'd.last_seen', status: 'd.approved' }, p.sort, p.dir, 'd.approved, d.last_seen desc, d.device_id');
    const from = 'from devices d join users u on u.id = d.user_id';
    const total = Number((await ctx.db.query<{ c: string }>(`select count(*) c ${from} ${w.sql}`, w.params)).rows[0]!.c);
    const pending = Number((await ctx.db.query<{ c: string }>('select count(*) c from devices where not approved')).rows[0]!.c);
    const r = await ctx.db.query(`select d.user_id, d.device_id, d.label, d.approved, d.last_seen, u.name ${from} ${w.sql} ${order} limit ${p.limit ?? 300} offset ${p.offset ?? 0}`, w.params);
    // `current`: the device this admin is using right now (the page offers no revoke for it)
    return { devices: r.rows.map((d) => ({ ...d, current: d.user_id === req.user!.id && d.device_id === req.session!.deviceId })), total, pending };
  });
  /** the device this admin request comes from: unapproving/removing it would sign the admin out */
  const ownDevice = (req: FastifyRequest, b: { userId: string; deviceId: string }) => b.userId === req.user!.id && b.deviceId === req.session!.deviceId;
  app.post('/api/admin/devices/approve', admin, async (req, reply) => {
    const b = z.object({ userId: uuid, deviceId: z.string().min(10).max(80) }).parse(req.body);
    const r = await ctx.db.query('update devices set approved=true where user_id=$1 and device_id=$2', [b.userId, b.deviceId]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(ctx, req.user!.id, 'device.approve', b.userId, { by: 'admin' });
    return { ok: true };
  });
  // inverse of approve (the Undo of the toast): the device waits for approval again
  app.post('/api/admin/devices/unapprove', admin, async (req, reply) => {
    const b = z.object({ userId: uuid, deviceId: z.string().min(10).max(80) }).parse(req.body);
    if (ownDevice(req, b)) return reply.code(400).send({ error: 'cannot_lock_yourself_out' });
    const r = await ctx.db.query('update devices set approved=false where user_id=$1 and device_id=$2', [b.userId, b.deviceId]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    // sessions cached deviceApproved=true (refreshDevice): sign them out, the device has to wait for approval after the next login
    await revokeSessions(ctx, b.userId, b.deviceId);
    await audit(ctx, req.user!.id, 'device.unapprove', b.userId, { by: 'admin' });
    return { ok: true };
  });
  // decline a waiting device / revoke an approved one: forget the device and sign out its sessions (it can register again)
  app.post('/api/admin/devices/remove', admin, async (req, reply) => {
    const b = z.object({ userId: uuid, deviceId: z.string().min(10).max(80) }).parse(req.body);
    if (ownDevice(req, b)) return reply.code(400).send({ error: 'cannot_lock_yourself_out' });
    const r = await ctx.db.query('delete from devices where user_id=$1 and device_id=$2', [b.userId, b.deviceId]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await revokeSessions(ctx, b.userId, b.deviceId);
    await audit(ctx, req.user!.id, 'device.remove', b.userId, { by: 'admin' });
    return { ok: true };
  });

  // ---- own devices ----
  app.post('/api/sessions/revoke-others', { preHandler: requireOwner(ctx) }, async (req) => {
    const n = await revokeSessions(ctx, req.user!.id, undefined, req.sid);
    await audit(ctx, req.user!.id, 'session.revoke_others', req.user!.id, { sessions: n });
    return { revoked: n };
  });
  app.get('/api/devices', { preHandler: requireGrownUp(ctx, { allowPendingDevice: true, allowNoProfile: true }) }, async (req) => {
    const r = await ctx.db.query('select device_id, label, approved, created_at, last_seen from devices where user_id=$1 order by created_at', [req.user!.id]);
    return { devices: r.rows.map((d) => ({ ...d, id: d.device_id, current: d.device_id === req.session!.deviceId })) };
  });
  app.post('/api/devices/:id/approve', { preHandler: requireOwner(ctx) }, async (req, reply) => {
    const id = z.string().min(10).max(80).parse((req.params as { id: string }).id);
    const r = await ctx.db.query('update devices set approved=true where user_id=$1 and device_id=$2', [req.user!.id, id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(ctx, req.user!.id, 'device.approve', req.user!.id, { by: 'self' });
    return { ok: true };
  });
  app.delete('/api/devices/:id', { preHandler: requireOwner(ctx) }, async (req, reply) => {
    const id = z.string().min(10).max(80).parse((req.params as { id: string }).id);
    if (id === req.session!.deviceId) return reply.code(400).send({ error: 'current_device' });
    await ctx.db.query('delete from devices where user_id=$1 and device_id=$2', [req.user!.id, id]);
    await revokeSessions(ctx, req.user!.id, id);
    await audit(ctx, req.user!.id, 'device.remove', req.user!.id);
    return { ok: true };
  });
}

/** Anonymous but token-protected: lets the invite landing page show what will be created. */
export function inviteRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/invite/:token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { lookupInvite } = await import('../invites.js');
    const token = (req.params as { token: string }).token;
    const inv = await lookupInvite(ctx, token);
    if (!inv) return reply.code(404).send({ error: 'invalid_or_expired' });
    // Relative portal URL: /auth/enroll starts the OIDC login and hands over to the Authentik enrollment flow.
    const enroll = Boolean(inv.authentik_invite && ctx.cfg.AUTHENTIK_URL && ctx.cfg.AUTHENTIK_ENROLL_FLOW);
    // anonymous page: the language the page shows (?lang=, from the browser's stored UI language) → instance default → German
    const q = (req.query as { lang?: unknown } | undefined)?.lang;
    const defaultLanguage = (await instanceLanguage(ctx)) ?? FALLBACK_LANGUAGE;
    const lang = isLanguage(q) ? q : defaultLanguage;
    // defaultLanguage: a new invitee without a stored UI language sees the page in the instance language (or the browser's)
    return { defaultLanguage, role: inv.role, roleLabel: roleLabel(lang, inv.role, ctx.roles[inv.role]?.label, DEFAULT_ROLES[inv.role]?.label), expiresAt: inv.expires_at, enrollUrl: enroll ? `/auth/enroll?invite=${encodeURIComponent(token)}` : undefined };
  });
}
