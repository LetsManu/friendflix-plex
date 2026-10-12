import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
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
      jellyfin: await ctx.jf.client.ping(),
    };
  });

  app.post('/api/admin/previews/regenerate', admin, async (req) => {
    const { itemId } = z.object({ itemId: z.string().regex(/^[0-9a-f]{32}$/) }).parse(req.body);
    await previews(ctx).regenerate(itemId);
    return { ok: true };
  });

  app.post('/api/admin/previews/regenerate-failed', admin, async () => ({ ok: true, count: await previews(ctx).regenerateFailed() }));

  app.get('/api/admin/previews', admin, async () => {
    const user = await serviceUser(ctx);
    const lib = user ? await libraryItems(ctx, user) : [];
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
    return {
      summary: { total: rows.length, ok: count('ok'), failed: count('failed'), missing: count('missing'), preparing: count('preparing'), totalBytes: rows.reduce((a, r) => a + (r.bytes ?? 0), 0) },
      items: rows,
    };
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
    await audit(ctx, req.user!.id, 'system.update', undefined, { from: info.current.sha, to: info.latest?.sha ?? null, mode });
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
    // builtinLabel: the label is the built-in (German) default of that role → the web app shows its translation; a label
    // renamed via ROLES_JSON is shown as configured (same rule as roleLabel() in /api/me and /api/invite)
    const builtin = (k: string, label: string) => Boolean(DEFAULT_ROLES[k] && DEFAULT_ROLES[k]!.label === label);
    const roles = Object.fromEntries(await Promise.all(Object.keys(ctx.roles).map(async (k) => { const r = (await effectiveRole(ctx, k))!; return [k, { ...r, builtinLabel: builtin(k, r.label) }] as const; })));
    const limits = Object.entries(roles).map(([role, t]) => ({ role, label: t.label, builtinLabel: t.builtinLabel, requestsPerMonth: set.has(role) ? set.get(role)! : defaultLimit(role), isDefault: !set.has(role), transcoding: t.transcoding, maxHeight: t.maxHeight, download: t.download, maxDownloads: t.maxDownloads, downloadMaxHeight: t.downloadMaxHeight, downloadDays: t.downloadDays }));
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
    }).parse(req.body);
    const before = await effectiveRole(ctx, role);
    const cur = (await ctx.db.query<{ requests_per_month: number | null }>('select requests_per_month from role_settings where role=$1', [role])).rows[0];
    const limit = b.requestsPerMonth !== undefined ? b.requestsPerMonth : cur ? cur.requests_per_month : defaultLimit(role);
    await ctx.db.query(
      `insert into role_settings(role, requests_per_month, transcoding, max_height, download, max_downloads, download_max_height, download_days) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (role) do update set requests_per_month=$2, transcoding=coalesce($3, role_settings.transcoding), max_height=coalesce($4, role_settings.max_height),
         download=coalesce($5, role_settings.download), max_downloads=coalesce($6, role_settings.max_downloads), download_max_height=coalesce($7, role_settings.download_max_height),
         download_days=coalesce($8, role_settings.download_days), updated_at=now()`,
      [role, limit, b.transcoding ?? null, b.maxHeight === undefined ? null : (b.maxHeight ?? 0), b.download ?? null, b.maxDownloads ?? null, b.downloadMaxHeight ?? null, b.downloadDays ?? null],
    );
    invalidateRoles(ctx);
    const after = (await effectiveRole(ctx, role))!;
    if (b.requestsPerMonth !== undefined) await audit(ctx, req.user!.id, 'role.request_limit', role, { requestsPerMonth: b.requestsPerMonth });
    const dlChanged = after.download !== before?.download || after.maxDownloads !== before?.maxDownloads || after.downloadMaxHeight !== before?.downloadMaxHeight || after.downloadDays !== before?.downloadDays;
    if (dlChanged) await audit(ctx, req.user!.id, 'role.downloads', role, { download: after.download, maxDownloads: after.maxDownloads, downloadMaxHeight: after.downloadMaxHeight, downloadDays: after.downloadDays });
    if (after.transcoding !== before?.transcoding || after.maxHeight !== before?.maxHeight || after.download !== before?.download) {
      if (after.transcoding !== before?.transcoding || after.maxHeight !== before?.maxHeight) await audit(ctx, req.user!.id, 'role.playback', role, { transcoding: after.transcoding, maxHeight: after.maxHeight });
      const failed = await reapplyRole(ctx, role); // push the new policy to existing Jellyfin accounts
      if (failed) return reply.code(502).send({ error: 'policy_partial', failed });
    }
    return { ok: true };
  });

  app.get('/api/admin/users', admin, async () => {
    const r = await ctx.db.query(
      `select u.id, u.name, u.email, u.role, u.disabled, u.jellyfin_username, u.seerr_user_id, u.created_at,
              (select max(last_seen) from devices d where d.user_id = u.id) last_seen
         from users u order by u.created_at`,
    );
    return { users: r.rows };
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
      for (const jid of ids) await applyRole(ctx, jid, b.role, b.disabled ?? user.disabled, hidden.has(jid) ? { IsHidden: true } : {}); // re-apply template to the Jellyfin account and all its profile users
      await ctx.db.query('update users set role=$1 where id=$2', [b.role, id]);
      await audit(ctx, req.user!.id, 'user.role', id, { from: user.role, to: b.role });
    }
    if (b.disabled !== undefined && b.disabled !== user.disabled) {
      for (const jid of await accountJellyfinIds(ctx, id)) await ctx.jf.client.setPolicy(jid, { IsDisabled: b.disabled });
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

  app.get('/api/admin/invites', admin, async () => {
    const r = await ctx.db.query(
      `select i.id, i.role, i.note, i.expires_at, i.used_at, u.name used_by_name
         from invites i left join users u on u.id = i.used_by order by i.created_at desc limit 100`,
    );
    return { invites: r.rows };
  });

  app.delete('/api/admin/invites/:id', admin, async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const r = await ctx.db.query<{ authentik_invite: string | null }>('delete from invites where id=$1 and used_at is null returning authentik_invite', [id]);
    await deleteAuthentikInvitation(ctx, r.rows[0]?.authentik_invite, req.log);
    await audit(ctx, req.user!.id, 'invite.revoke', id);
    return { ok: true };
  });

  app.get('/api/admin/lists', admin, async () => {
    const r = await ctx.db.query<{ id: string; name: string; owner_id: string; owner_name: string; item_count: string; featured: boolean }>(
      `select l.id, l.name, l.owner_id, o.name as owner_name, (select count(*) from list_items i where i.list_id = l.id) as item_count, l.featured_at is not null as featured
         from lists l join users o on o.id = l.owner_id order by l.created_at desc limit 200`);
    return { lists: r.rows.map((x) => ({ id: x.id, name: x.name, owner: { id: x.owner_id, name: x.owner_name }, itemCount: Number(x.item_count), featured: x.featured })) };
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

  app.get('/api/admin/audit', admin, async (req) => {
    const limit = z.coerce.number().int().min(1).max(500).default(100).parse((req.query as { limit?: string }).limit);
    const r = await ctx.db.query(
      'select a.id, a.at, a.action, a.target, a.meta, u.name actor from audit_log a left join users u on u.id = a.actor order by a.id desc limit $1',
      [limit],
    );
    return { entries: r.rows };
  });

  app.get('/api/admin/devices', admin, async () => {
    const r = await ctx.db.query('select d.user_id, d.device_id, d.label, d.approved, d.last_seen, u.name from devices d join users u on u.id=d.user_id order by d.approved, d.last_seen desc limit 300');
    return { devices: r.rows };
  });
  app.post('/api/admin/devices/approve', admin, async (req, reply) => {
    const b = z.object({ userId: uuid, deviceId: z.string().min(10).max(80) }).parse(req.body);
    const r = await ctx.db.query('update devices set approved=true where user_id=$1 and device_id=$2', [b.userId, b.deviceId]);
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    await audit(ctx, req.user!.id, 'device.approve', b.userId, { by: 'admin' });
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
