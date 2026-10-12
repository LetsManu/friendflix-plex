import type { Ctx } from './ctx.js';
import { broadcastLanguage, isMsg, renderKnown, renderNotice, userLanguage, type Language, type Rendered, type Text } from './i18n.js';
export { renderNotice, type Rendered } from './i18n.js';
import { sendWebPush } from './push.js';

export interface Notice {
  /** null = broadcast to everyone */
  userId: string | null;
  kind: string;
  /** plain text or a message (`m('key', params)`, see i18n.ts) rendered in the recipient's language */
  title: Text;
  body?: Text | null;
  link?: string;
  /** notifications with the same dedupe key are only created once */
  dedupe?: string;
  /** also push to ntfy / Discord */
  external?: boolean;
  /** also push to the recipient's own ntfy topic (never to the global ntfy / Discord) */
  personal?: boolean;
  /** text of the personal ntfy push when it should differ from the in-app body (e.g. titles that must not sit in the inbox) */
  pushBody?: Text;
}

/** Stored next to a notification when title/body are messages: the inbox renders them in the reader's language. */
const storedMsg = (n: Notice) => (isMsg(n.title) || isMsg(n.body) ? JSON.stringify({ title: n.title, ...(n.body != null ? { body: n.body } : {}) }) : null);

/** Title/body of a stored notification in `lang` (falls back to the stored text, which is in the recipient's language at creation). */
export function localizeStored<T extends { title: string; body: string | null; msg?: unknown }>(row: T, lang: Language): Omit<T, 'msg'> {
  const { msg: raw, ...rest } = row;
  const o = raw && typeof raw === 'object' ? (raw as { title?: Text; body?: Text }) : null;
  if (!o) return rest;
  // renderKnown: null when a key was renamed/removed since the row was stored (msg() would show the raw key) → stored text
  const title = o.title != null ? renderKnown(lang, o.title) : null;
  const body = o.body != null ? renderKnown(lang, o.body) : null;
  return { ...rest, title: title || rest.title, body: body || rest.body };
}

/**
 * Creates an in-app notification and fans it out. Texts are rendered per recipient: the account's language for its inbox
 * and personal ntfy topic, the instance language for broadcasts / the global ntfy topic / Discord, and each push
 * subscription's profile language for Web Push.
 */
export async function notify(ctx: Pick<Ctx, 'db' | 'cfg' | 'fetchImpl'>, n: Notice): Promise<boolean> {
  const instLang = await broadcastLanguage(ctx);
  const lang = n.userId ? await userLanguage(ctx, n.userId) : instLang;
  const text = renderNotice(n, lang);
  const r = await ctx.db.query(
    'insert into notifications(user_id, kind, title, body, link, dedupe, msg) values ($1,$2,$3,$4,$5,$6,$7) on conflict (dedupe) do nothing returning id',
    [n.userId, n.kind, text.title, text.body ?? null, n.link ?? null, n.dedupe ?? null, storedMsg(n)],
  );
  if (!r.rowCount) return false;
  // Web Push: fire-and-forget, never blocks or fails the caller (tests await sendWebPush directly)
  void sendWebPush(ctx, n).catch(() => undefined);
  if (n.external) await pushExternal(ctx, renderNotice(n, instLang)).catch(() => undefined);
  if (n.personal && n.userId) await pushPersonal(ctx, n.userId, { title: text.title, body: text.pushBody ?? text.body, link: n.link }).catch(() => undefined);
  return true;
}

/** Base URL of the ntfy server for personal topics: NTFY_BASE_URL, else the origin of NTFY_URL; null = not configured. */
export function ntfyBase(cfg: Pick<Ctx['cfg'], 'NTFY_BASE_URL' | 'NTFY_URL'>): string | null {
  try {
    if (cfg.NTFY_BASE_URL) return new URL(cfg.NTFY_BASE_URL).toString().replace(/\/+$/, '');
    if (cfg.NTFY_URL) return new URL(cfg.NTFY_URL).origin;
  } catch { /* invalid URL -> off */ }
  return null;
}

/** Posts to the user's own ntfy topic (user_prefs.ntfyTopic) on the configured ntfy server only. Never Discord, never the global topic. */
export async function pushPersonal(ctx: Pick<Ctx, 'db' | 'cfg' | 'fetchImpl'>, userId: string, n: Pick<Rendered, 'title' | 'body' | 'link'>): Promise<boolean> {
  const base = ntfyBase(ctx.cfg);
  if (!base) return false;
  const r = await ctx.db.query<{ topic: string | null }>("select data->>'ntfyTopic' as topic from user_prefs where user_id=$1", [userId]);
  const topic = r.rows[0]?.topic;
  if (!topic || !/^[A-Za-z0-9_-]{1,64}$/.test(topic)) return false;
  const click = n.link ? new URL(n.link, ctx.cfg.PUBLIC_URL).toString() : undefined;
  const res = await ctx.fetchImpl(new URL(encodeURIComponent(topic), `${base}/`).toString(), {
    method: 'POST',
    headers: { Title: encodeURIComponent(n.title).slice(0, 200), ...(click ? { Click: click } : {}) },
    body: n.body ?? n.title,
    signal: AbortSignal.timeout(8000),
  });
  return res.ok;
}

/** ntfy: plain POST with Title header. Discord: webhook JSON. Failures never break the caller. */
export async function pushExternal(ctx: Pick<Ctx, 'cfg' | 'fetchImpl'>, n: Pick<Rendered, 'title' | 'body' | 'link'>) {
  const text = n.body ? `${n.title}\n${n.body}` : n.title;
  const jobs: Promise<unknown>[] = [];
  if (ctx.cfg.NTFY_URL) {
    jobs.push(ctx.fetchImpl(ctx.cfg.NTFY_URL, {
      method: 'POST',
      headers: { Title: encodeURIComponent(n.title).slice(0, 200), ...(n.link ? { Click: n.link } : {}) },
      body: n.body ?? n.title,
      signal: AbortSignal.timeout(8000),
    }));
  }
  if (ctx.cfg.DISCORD_WEBHOOK_URL) {
    jobs.push(ctx.fetchImpl(ctx.cfg.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(8000),
    }));
  }
  await Promise.allSettled(jobs);
}
