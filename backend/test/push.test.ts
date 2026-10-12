import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { notify } from '../src/notify.js';
import { revokeSessions } from '../src/devices.js';
import { endpointAllowed, pushEnabled, sendWebPush } from '../src/push.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

type Sess = { cookies: Record<string, string>; csrf: string };
const vapid = webpush.generateVAPIDKeys();
const FCM = 'https://fcm.googleapis.com/fcm/send/';
const keys = () => {
  const e = createECDH('prime256v1');
  e.generateKeys();
  return { p256dh: e.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
};

let env: TestEnv;
let a: Sess;
let b: Sess;
let aId: string;
let bId: string;
const sent: Array<{ url: string; status: number; redirect?: string }> = [];
const nextStatus = 201;
const statusFor = new Map<string, number>();

const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });
const subApi = (s: Sess, id: string, extra: Record<string, unknown> = {}) => call(s, 'POST', '/api/push/subscribe', { endpoint: FCM + id, keys: keys(), ...extra });
/** direct insert (the subscribe route is rate limited to 10/min) for the user behind a session */
async function sub(s: Sess, id: string, extra: { broadcast?: boolean } = {}) {
  const uid = s === a ? aId : bId;
  const dev = (await env.pool.query('select device_id from devices where user_id=$1', [uid])).rows[0].device_id;
  const prof = (await env.pool.query('select id from profiles where user_id=$1 and is_owner', [uid])).rows[0].id;
  const k = keys();
  await env.pool.query('insert into push_subscriptions(user_id, device_id, profile_id, endpoint, p256dh, auth, broadcast) values ($1,$2,$3,$4,$5,$6,$7) on conflict (endpoint) do nothing', [uid, dev, prof, FCM + id, k.p256dh, k.auth, extra.broadcast ?? false]);
}
const count = async () => Number((await env.pool.query('select count(*) from push_subscriptions')).rows[0].count);

beforeAll(async () => {
  env = await makeEnv({}, {
    ctxPatch: (c) => {
      c.cfg = { ...c.cfg, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey };
      c.fetchImpl = (async (url: string, init?: RequestInit) => {
        const status = statusFor.get(String(url)) ?? nextStatus;
        sent.push({ url: String(url), status, redirect: init?.redirect });
        return new Response(null, { status });
      }) as unknown as typeof fetch;
    },
  });
  a = await env.login(ADMIN);
  b = await env.login({ sub: 'sub-b', email: 'b@example.com', name: 'Bea', groups: ['friendflix-admins'] });
  aId = (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id;
  bId = (await env.pool.query("select id from users where authentik_sub='sub-b'")).rows[0].id;
});
afterAll(async () => { await env.close(); });

describe('web push', () => {
  it('config exposes the public key when enabled', async () => {
    const r = await call(a, 'GET', '/api/push/config');
    expect(r.json()).toEqual({ enabled: true, publicKey: vapid.publicKey });
  });

  it('endpoint allowlist', () => {
    for (const ok of [FCM + 'x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://db5p.notify.windows.com/w/?token=x', 'https://web.push.apple.com/x', 'https://api.push.apple.com/3/device/x']) expect(endpointAllowed(ok), ok).toBe(true);
    for (const bad of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://evil.example.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://user@fcm.googleapis.com/x', 'nonsense']) expect(endpointAllowed(bad), bad).toBe(false);
  });

  it('subscribe validates input and SSRF-guards the endpoint', async () => {
    expect((await call(a, 'POST', '/api/push/subscribe', { endpoint: 'https://evil.example.com/x', keys: keys() })).json()).toEqual({ error: 'push_endpoint_denied' });
    expect((await call(a, 'POST', '/api/push/subscribe', { endpoint: 'http://169.254.169.254/x', keys: keys() })).statusCode).toBe(400);
    expect((await call(a, 'POST', '/api/push/subscribe', { endpoint: FCM + 'v', keys: { p256dh: 'not base64 !', auth: 'x' } })).statusCode).toBe(400);
    expect((await call(a, 'POST', '/api/push/subscribe', { endpoint: FCM + 'v' })).statusCode).toBe(400);
    expect((await env.app.inject({ method: 'POST', url: '/api/push/subscribe', payload: {} })).statusCode).toBe(401);
    expect(await count()).toBe(0);
    const ok = await subApi(a, 'a1');
    expect(ok.json()).toEqual({ ok: true, broadcast: false });
    expect(await count()).toBe(1);
  });

  it('upsert reassigns an endpoint to the new user', async () => {
    await subApi(a, 'shared');
    await subApi(b, 'shared', { broadcast: true });
    const r = await env.pool.query('select user_id, broadcast from push_subscriptions where endpoint=$1', [FCM + 'shared']);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].user_id).toBe(bId);
    expect(r.rows[0].broadcast).toBe(true);
    // omitting `broadcast` (settings page re-sync) keeps the stored choice
    expect((await subApi(b, 'shared')).json().broadcast).toBe(true);
    await env.pool.query('delete from push_subscriptions');
  });

  it('unsubscribe is scoped to the caller', async () => {
    await sub(a, 'u1');
    await call(b, 'POST', '/api/push/unsubscribe', { endpoint: FCM + 'u1' });
    expect(await count()).toBe(1);
    await call(a, 'POST', '/api/push/unsubscribe', { endpoint: FCM + 'u1' });
    expect(await count()).toBe(0);
  });

  it('test endpoint only works for own subscriptions and sends one push', async () => {
    await sub(a, 't1');
    sent.length = 0;
    expect((await call(b, 'POST', '/api/push/test', { endpoint: FCM + 't1' })).statusCode).toBe(404);
    expect(sent).toHaveLength(0);
    const r = await call(a, 'POST', '/api/push/test', { endpoint: FCM + 't1' });
    expect(r.json()).toEqual({ sent: true, status: 201 });
    expect(sent.map((s) => s.url)).toEqual([FCM + 't1']);
    await env.pool.query('delete from push_subscriptions');
  });

  it('notify to a user pushes only that user\'s subscriptions', async () => {
    await sub(a, 'ua'); await sub(b, 'ub');
    sent.length = 0;
    await sendWebPush(env.ctx, { userId: aId, kind: 'x', title: 'T', body: 'B', link: '/x' });
    expect(sent.map((s) => s.url)).toEqual([FCM + 'ua']);
    // notify() itself is fire-and-forget but does reach the sender
    sent.length = 0;
    await notify(env.ctx, { userId: bId, kind: 'x', title: 'T', body: 'B' });
    await vi.waitFor(() => expect(sent.map((s) => s.url)).toEqual([FCM + 'ub']));
    await env.pool.query('delete from push_subscriptions');
  });

  it('broadcast notices only go to broadcast subscriptions', async () => {
    await sub(a, 'ba', { broadcast: true }); await sub(b, 'bb'); await sub(b, 'bc', { broadcast: true });
    sent.length = 0;
    await sendWebPush(env.ctx, { userId: null, kind: 'movie_night', title: 'T' });
    expect(sent.map((s) => s.url).sort()).toEqual([FCM + 'ba', FCM + 'bc']);
    await env.pool.query('delete from push_subscriptions');
  });

  it('payload: owner gets the text (pushBody wins), unsafe links are dropped, non-owner profiles get a generic text', async () => {
    const orig = webpush.generateRequestDetails;
    const payloads: Array<Record<string, string>> = [];
    (webpush as { generateRequestDetails: unknown }).generateRequestDetails = (s: unknown, p: string, o: unknown) => { payloads.push(JSON.parse(p)); return orig.call(webpush, s as never, p, o as never); };
    try {
      await sub(a, 'own');
      await sendWebPush(env.ctx, { userId: aId, kind: 'k', title: 'Titel', body: 'inbox', pushBody: 'geheim', link: '//evil.example.com' });
      expect(payloads[0]).toMatchObject({ title: 'Titel', body: 'geheim', tag: 'k' });
      expect(payloads[0]!.link).toBeUndefined();
      await sendWebPush(env.ctx, { userId: aId, kind: 'k', title: 'Titel', body: 'x'.repeat(1000), link: '/watch/1' });
      expect(payloads[1]!.body).toHaveLength(300);
      expect(payloads[1]!.link).toBe('/watch/1');
      // non-owner profile
      const pr = await call(a, 'POST', '/api/profiles', { name: 'Kind' });
      const kid = pr.json().profile.id as string;
      await env.pool.query("update push_subscriptions set profile_id=$1 where endpoint=$2", [kid, FCM + 'own']);
      payloads.length = 0;
      await sendWebPush(env.ctx, { userId: aId, kind: 'k', title: 'Titel', body: 'inbox', link: '/watch/1' });
      expect(payloads[0]).toMatchObject({ title: 'FriendFlix', body: 'Neue Benachrichtigung', link: '/' });
    } finally {
      (webpush as { generateRequestDetails: unknown }).generateRequestDetails = orig;
    }
    await env.pool.query('delete from push_subscriptions');
  });

  it('410/404 delete the subscription, 500 counts failures, 201 resets them', async () => {
    await sub(a, 'gone'); await sub(a, 'flaky');
    statusFor.set(FCM + 'gone', 410); statusFor.set(FCM + 'flaky', 500);
    await sendWebPush(env.ctx, { userId: aId, kind: 'k', title: 'T' });
    let r = await env.pool.query('select endpoint, fail_count from push_subscriptions');
    expect(r.rows).toEqual([{ endpoint: FCM + 'flaky', fail_count: 1 }]);
    statusFor.set(FCM + 'flaky', 201);
    await sendWebPush(env.ctx, { userId: aId, kind: 'k', title: 'T' });
    r = await env.pool.query('select fail_count, last_ok_at from push_subscriptions');
    expect(r.rows[0].fail_count).toBe(0);
    expect(r.rows[0].last_ok_at).not.toBeNull();
    // persistently failing for > 7 days -> removed at the 10th failure
    statusFor.set(FCM + 'flaky', 503);
    await env.pool.query("update push_subscriptions set fail_count=9, last_ok_at=now()-interval '8 days'");
    await sendWebPush(env.ctx, { userId: aId, kind: 'k', title: 'T' });
    expect(await count()).toBe(0);
    statusFor.clear();
  });

  it('revoking a device deletes its subscriptions', async () => {
    await sub(a, 'rev');
    expect(await count()).toBe(1);
    const dev = (await env.pool.query('select device_id from push_subscriptions')).rows[0].device_id as string;
    await revokeSessions(env.ctx, aId, 'other-device');
    expect(await count()).toBe(1);
    await revokeSessions(env.ctx, aId, dev);
    expect(await count()).toBe(0);
  });

  it('never follows redirects of the push service', async () => {
    await sub(a, 'redir');
    sent.length = 0;
    await sendWebPush(env.ctx, { userId: aId, kind: 'k', title: 'T' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.redirect).toBe('error');
    await env.pool.query('delete from push_subscriptions');
  });

  it('an invalid VAPID pair disables push (validated once) and never counts as a subscription failure', async () => {
    await sub(a, 'badvapid');
    const saved = env.ctx.cfg;
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (m: string) => { warnings.push(String(m)); };
    env.ctx.cfg = { ...saved, VAPID_PUBLIC_KEY: 'not-a-key', VAPID_PRIVATE_KEY: 'also-not' };
    try {
      expect(pushEnabled(env.ctx.cfg)).toBe(false);
      expect(pushEnabled(env.ctx.cfg)).toBe(false);
      expect(warnings.filter((w) => w.includes('invalid VAPID'))).toHaveLength(1); // one warning, not one per call
      expect((await call(b, 'GET', '/api/push/config')).json()).toEqual({ enabled: false });
      sent.length = 0;
      await sendWebPush(env.ctx, { userId: aId, kind: 'k', title: 'T' });
      expect(sent).toHaveLength(0);
      expect((await env.pool.query('select fail_count from push_subscriptions')).rows[0].fail_count).toBe(0);
    } finally {
      console.warn = warn;
      env.ctx.cfg = saved;
      await env.pool.query('delete from push_subscriptions');
    }
  });

  it('a subscription whose request cannot be built is not counted as failed', async () => {
    await sub(a, 'brokenkeys');
    await env.pool.query("update push_subscriptions set p256dh='AAAA'");
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      sent.length = 0;
      await sendWebPush(env.ctx, { userId: aId, kind: 'k', title: 'T' });
      expect(sent).toHaveLength(0);
      expect((await env.pool.query('select fail_count from push_subscriptions')).rows[0].fail_count).toBe(0);
    } finally {
      console.warn = warn;
      await env.pool.query('delete from push_subscriptions');
    }
  });

  it('is disabled without VAPID keys', async () => {
    const saved = env.ctx.cfg;
    env.ctx.cfg = { ...saved, VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined };
    try {
      expect((await call(b, 'GET', '/api/push/config')).json()).toEqual({ enabled: false });
      expect((await subApi(b, 'off')).statusCode).toBe(404);
      sent.length = 0;
      await sendWebPush(env.ctx, { userId: bId, kind: 'k', title: 'T' });
      expect(sent).toHaveLength(0);
    } finally {
      env.ctx.cfg = saved;
    }
  });
});
