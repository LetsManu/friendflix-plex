// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadJar } from '../src/akflow.js';
import { sha256 } from '../src/crypto.js';
import type { OidcProvider } from '../src/oidc.js';
import { provisionUser } from '../src/users.js';
import { type FakeStage, fixture } from './akflow-fake.js';
import { makeEnv, type TestEnv } from './helpers.js';
import { AK_CFG, ANNA, BEN, browser, executorPosts, installWorld, LOGIN, loginStages, type World } from './reauth-fake.js';

// Block 23 phase 3, Task 10: the e-mail change (prompt → confirmation link → users.email) and its blueprint.

const SLUG = 'friendflix-email-change';
const INVALIDATION = '/api/v3/flows/executor/default-invalidation-flow/';
const LINK = '00000000-0000-4000-8000-000000000001';
/** obviously fake: shaped like Authentik's FlowToken key only in its alphabet */
const TOKEN = 'fakeFlowTokenForTestsOnly0000000000000000000000000000000001';
const NEW_ADDRESS = 'Neu@Example.com';

const emailPrompt = () => ({
  component: 'ak-stage-prompt',
  flow_info: { title: 'Change e-mail address' },
  pending_user: 'anna',
  fields: [{ field_key: 'email', type: 'email', label: 'New e-mail address', required: true, placeholder: '', order: 0 }],
});
const changeStages = (): FakeStage[] => [
  { challenge: emailPrompt(), answer: (b: { email?: string }) => (b.email ? true : emailPrompt()) },
  { challenge: fixture('email-sent'), answer: () => fixture('email-resent') },
];

describe('e-mail change', () => {
  let env: TestEnv;
  let w: World;
  const logs: string[] = [];
  const oidc: OidcProvider = {
    async start() {
      const state = `st${Math.random().toString(36).slice(2)}`;
      const url = new URL('/application/o/authorize/', 'https://auth.example.com');
      url.searchParams.set('state', state);
      return { url: url.toString(), state, nonce: `n-${state}`, codeVerifier: `v-${state}` };
    },
    async finish(_url, _saved) {
      return { authTime: Math.floor(Date.now() / 1000), ...env.claims.current };
    },
  };
  const world = (flows: Record<string, FakeStage[]> = { [LOGIN]: loginStages(), [SLUG]: changeStages() }) => {
    w = installWorld(env, flows);
  };
  const audits = async (action: string) => (await env.pool.query<{ actor: string; target: string; meta: Record<string, unknown> }>('select actor, target, meta from audit_log where action=$1 order by id', [action])).rows;
  const emailOf = async () => (await env.pool.query<{ email: string }>("select email from users where authentik_sub='sub-admin'")).rows[0]!.email;
  const flowId = (b: ReturnType<typeof browser>) => b.cookies.ff_flow!;

  beforeAll(async () => {
    env = await makeEnv({}, { logger: { stream: { write: (m: string) => { logs.push(m); } }, level: 'trace' } });
  });
  beforeEach(async () => {
    env.ctx.cfg = { ...env.ctx.cfg, ...AK_CFG, AUTHENTIK_EMAIL_CHANGE_FLOW: SLUG };
    env.ctx.oidc = oidc;
    env.claims.current = { sub: 'sub-admin', email: 'admin@example.com', name: 'Admin', groups: ['friendflix-admins'] };
    world();
    for (const p of ['flowfail:', 'akflow', 'akmfa:', 'akuser:', 'emailchange:', 'recoverymail:']) for (const k of await env.kv.keys(p)) await env.kv.del(k);
    await env.pool.query("delete from audit_log where action like 'account.%'");
    await env.pool.query("update users set email='admin@example.com' where authentik_sub='sub-admin'");
    await env.pool.query("delete from users where authentik_sub='sub-carl'");
  });
  afterAll(() => env.close());

  /** a re-authentication into the e-mail change flow; returns the prompt step */
  async function prompted() {
    const s = await env.login();
    const b = browser(env, s);
    const step = (await b.reauth('change-email')).json() as { stage: string; step: string; fields: unknown[] };
    return { s, b, step };
  }

  it('reauth then change-email → prompt with one email field', async () => {
    const { step } = await prompted();
    expect(step).toEqual({ stage: 'prompt', step: expect.any(String), fields: [{ key: 'email', type: 'email', label: 'ff:new_email', required: true }] });
    // the e-mail flow never forwards the app host (only the re-authentication may)
    expect(w.calls.filter((c) => c.path === `/api/v3/flows/executor/${SLUG}/`).every((c) => !c.headers['x-forwarded-host'])).toBe(true);
  });

  it('change-email is refused up front when Authentik has no such flow', async () => {
    const s = await env.login();
    env.ctx.cfg = { ...env.ctx.cfg, AUTHENTIK_EMAIL_CHANGE_FLOW: 'no-such-flow' };
    const b = browser(env, s);
    await b.config();
    const r = await b.post('start', { kind: 'reauth', then: 'change-email' });
    expect([r.statusCode, r.json()]).toEqual([409, { error: 'flow_not_configured' }]);
  });

  it('an address used by another user → email_in_use, no Authentik call; invalid and unchanged addresses too', async () => {
    const { b, step } = await prompted();
    await provisionUser(env.ctx, { sub: 'sub-carl', email: 'carl@example.com', name: 'Carl', groups: [] }, 'friend', null);
    const before = w.calls.length;
    let cur = step.step;
    const ask = async (email: string) => {
      const r = await b.post('answer', { step: cur, stage: 'prompt', email });
      expect(r.statusCode).toBe(200);
      const j = r.json() as { step: string; errors?: string[] };
      cur = j.step;
      return j;
    };
    expect(await ask('CARL@example.com')).toMatchObject({ stage: 'prompt', errors: ['email_in_use'] }); // another FriendFlix user, any case
    expect(w.calls.length).toBe(before); // no Authentik call at all
    expect(await ask('ben@ELSEWHERE.example.com')).toMatchObject({ errors: ['email_in_use'] }); // an Authentik user (looked up, nothing sent)
    expect(executorPosts(w, SLUG)).toHaveLength(0);
    expect(await ask('not an address')).toMatchObject({ errors: ['invalid'] });
    expect(await ask('a@b')).toMatchObject({ errors: ['invalid'] });
    expect(await ask('Admin@Example.com')).toMatchObject({ errors: ['invalid'] }); // the current address
    expect(await ask('   ')).toMatchObject({ errors: ['required'] });
    // longer than 254 characters never gets that far: the shape check refuses it first (400), nothing is used up
    const long = await b.post('answer', { step: cur, stage: 'prompt', email: `${'x'.repeat(250)}@example.com` });
    expect([long.statusCode, long.json()]).toEqual([400, { error: 'bad_request' }]);
    expect(executorPosts(w, SLUG)).toHaveLength(0);
    // none of the refusals used a mail
    expect(await env.kv.get(`recoverymail:ip:${sha256(b.ip)}`)).toBeNull();
  });

  it('answer → email-sent masked to the NEW address, Authentik session ended, audit without addresses', async () => {
    const { s, b, step } = await prompted();
    const r = await b.post('answer', { step: step.step, stage: 'prompt', email: ` ${NEW_ADDRESS} ` });
    expect(r.json()).toEqual({ stage: 'email-sent', step: expect.any(String), to: 'N•••@example.com' });
    expect(executorPosts(w, SLUG).map((c) => c.body)).toEqual([{ email: NEW_ADDRESS }]); // trimmed, nothing else
    // the session is ended (the link works without it) and the attempt is over
    expect(w.calls.some((c) => c.path === INVALIDATION && /authentik_session=/.test(c.headers.cookie ?? ''))).toBe(true);
    expect(await loadJar(env.ctx, flowId(b) ?? 'none')).toBeNull();
    expect(b.cookies.ff_flow).toBeUndefined();
    expect(r.cookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
    // audit: field names only, the actor is the person
    const rows = await audits('account.email_requested');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toEqual({ fields: ['email'] });
    expect(JSON.stringify(rows)).not.toMatch(/example\.com/);
    // the pending address: encrypted in kv for 30 minutes, shown masked on the account page; users.email is unchanged
    const userId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub='sub-admin'")).rows[0]!.id;
    const blob = (await env.kv.get(`emailchange:${userId}`))!;
    expect(blob).toBeTruthy();
    expect(blob).not.toMatch(/neu|example/i);
    expect((await env.app.inject({ url: '/api/account', cookies: s.cookies })).json().emailChangePending).toBe('N•••@example.com');
    expect((await env.app.inject({ url: '/api/account/security', cookies: s.cookies })).json().emailChangePending).toBe('N•••@example.com');
    expect(await emailOf()).toBe('admin@example.com');
    // nothing in the logs
    expect(logs.join('\n')).not.toMatch(/Neu@|neu@/i);
  });

  it('the mail budget of the IP is shared with recovery: used up → rate_limited and no mail', async () => {
    const { b, step } = await prompted();
    await env.kv.set(`recoverymail:ip:${sha256(b.ip)}`, '10', 3600);
    const r = await b.post('answer', { step: step.step, stage: 'prompt', email: NEW_ADDRESS });
    expect(r.json()).toMatchObject({ stage: 'prompt', errors: ['rate_limited'] });
    expect(executorPosts(w, SLUG)).toHaveLength(0);
    expect(await audits('account.email_requested')).toHaveLength(0);
  });

  it('a mail that Authentik refuses to send gives the budget back', async () => {
    world({ [LOGIN]: loginStages(), [SLUG]: [{ challenge: emailPrompt(), answer: () => fixture('prompt-mismatch') }] });
    const { b, step } = await prompted();
    const r = await b.post('answer', { step: step.step, stage: 'prompt', email: NEW_ADDRESS });
    expect(r.json()).toMatchObject({ stage: 'prompt', errors: ['invalid'] });
    expect(Number((await env.kv.get(`recoverymail:ip:${sha256(b.ip)}`)) ?? 0)).toBe(0);
  });

  describe('resume (the e-mail link)', () => {
    const resumeStages = (): FakeStage[] => [{ challenge: fixture('consent-link'), answer: (b: { token?: string }) => (b.token === LINK ? true : fixture('consent-link')), hops: 2 }];
    async function resumed(token = TOKEN) {
      const b = browser(env);
      await b.config();
      const r = await b.post('resume', { token, kind: 'email-confirm' });
      return { b, r };
    }

    it('answers the interstitial, then final_redirect → users.email from Authentik, audit account.email, no session cookie', async () => {
      await env.login();
      const userId = (await env.pool.query<{ id: string }>("select id from users where authentik_sub='sub-admin'")).rows[0]!.id;
      await env.kv.set(`emailchange:${userId}`, 'blob', 1800);
      world({ [SLUG]: resumeStages() });
      // Authentik's user write stage has written the new address
      w.people = [{ ...ANNA, email: 'neu@example.com' }, BEN];
      const { b, r } = await resumed();
      expect([r.statusCode, r.json()]).toEqual([200, { stage: 'done', next: '/confirm-email?ok=1' }]);
      expect(await emailOf()).toBe('neu@example.com');
      // the account is the one the interstitial named (pending_user), looked up by username
      expect(w.calls.some((c) => c.path === '/api/v3/core/users/' && c.search.includes('username=anna'))).toBe(true);
      expect(executorPosts(w, SLUG).map((c) => c.body)).toEqual([{ token: LINK }]);
      const rows = await audits('account.email');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor: userId, target: userId, meta: { fields: ['email'] } });
      expect(await env.kv.get(`emailchange:${userId}`)).toBeNull();
      // no FriendFlix and no Authentik session is created; the Authentik session of the link is ended; nothing leaks
      expect(r.cookies.find((c) => c.name === 'ff_sid')).toBeUndefined();
      expect(b.cookies.ff_flow).toBeUndefined();
      expect(w.calls.some((c) => c.path === INVALIDATION)).toBe(true);
      expect(w.calls.filter((c) => c.path.startsWith(`/api/v3/flows/executor/${SLUG}/`)).every((c) => c.search === `?query=flow_token%3D${TOKEN}`)).toBe(true);
      expect(r.body).not.toContain(TOKEN);
      expect(r.body).not.toContain('neu@');
      expect(logs.join('\n')).not.toContain(TOKEN);
    });

    it('the address comes from Authentik, never from the client; one that another account took meanwhile → expired', async () => {
      world({ [SLUG]: resumeStages() });
      w.people = [{ ...ANNA, email: 'neu@example.com' }, BEN];
      await provisionUser(env.ctx, { sub: 'sub-carl', email: 'NEU@example.com', name: 'Carl', groups: [] }, 'friend', null);
      const { r } = await resumed();
      expect(r.json()).toEqual({ stage: 'expired' });
      expect(await emailOf()).toBe('admin@example.com');
      expect(await audits('account.email')).toHaveLength(0);
    });

    it('a used token → expired, users.email unchanged', async () => {
      world({ [SLUG]: [{ challenge: fixture('recovery-token-reused') }] });
      w.people = [{ ...ANNA, email: 'neu@example.com' }, BEN];
      const { r } = await resumed();
      expect(r.json()).toEqual({ stage: 'expired' });
      expect(await emailOf()).toBe('admin@example.com');
      expect(await audits('account.email')).toHaveLength(0);
      // access denied, no interstitial first, or a plan that goes on instead of ending → expired as well
      world({ [SLUG]: [{ challenge: fixture('access-denied') }] });
      expect((await resumed()).r.json()).toEqual({ stage: 'expired' });
      world({ [SLUG]: [{ challenge: fixture('prompt-recovery') }] });
      expect((await resumed()).r.json()).toEqual({ stage: 'expired' });
      world({ [SLUG]: [{ challenge: fixture('consent-link'), answer: () => true }, { challenge: fixture('prompt-recovery') }] });
      expect((await resumed()).r.json()).toEqual({ stage: 'expired' });
      expect(await emailOf()).toBe('admin@example.com');
    });

    it('an unknown account or an unusable address → expired; a bad token never reaches Authentik', async () => {
      world({ [SLUG]: resumeStages() });
      w.people = [{ ...ANNA, username: 'someone-else', email: 'neu@example.com' }, BEN];
      expect((await resumed()).r.json()).toEqual({ stage: 'expired' });
      world({ [SLUG]: resumeStages() });
      w.people = [{ ...ANNA, email: 'not-an-address' }, BEN];
      expect((await resumed()).r.json()).toEqual({ stage: 'expired' });
      const before = w.calls.length;
      expect((await resumed('short')).r.json()).toEqual({ stage: 'expired' });
      expect(w.calls.length).toBe(before);
      expect(await emailOf()).toBe('admin@example.com');
    });

    it('needs the flow csrf, is limited to 10 per minute and IP, and refuses the classic mode', async () => {
      world({ [SLUG]: resumeStages() });
      w.people = [{ ...ANNA, email: 'neu@example.com' }, BEN];
      const b = browser(env);
      await b.config();
      expect((await b.post('resume', { token: TOKEN, kind: 'email-confirm' }, { csrf: null })).statusCode).toBe(403);
      env.ctx.cfg = { ...env.ctx.cfg, LOGIN_UI: 'authentik' };
      expect((await b.post('resume', { token: TOKEN, kind: 'email-confirm' })).json()).toEqual({ error: 'classic' });
      env.ctx.cfg = { ...env.ctx.cfg, LOGIN_UI: undefined };
      const codes: number[] = [];
      for (let i = 0; i < 11; i++) codes.push((await b.post('resume', { token: 'short', kind: 'email-confirm' })).statusCode);
      expect(codes.slice(-1)).toEqual([429]);
    });
  });

  it('the blueprint file parses and contains the policy binding with re_evaluate_policies true', () => {
    const text = readFileSync(new URL('../../deploy/authentik/friendflix-email-change.yaml', import.meta.url), 'utf8');
    expect(text).toMatch(/^version: 1$/m);
    expect(text).toMatch(/slug: friendflix-email-change/);
    expect(text).toMatch(/authentication: require_authenticated/);
    expect(text).toMatch(/template: friendflix-email-change\.html/);
    // the stage bindings: prompt 10, email 20, user write 30
    const entries = text.split(/\n {2}- model: /).slice(1);
    const models = entries.map((e) => e.split('\n')[0]);
    expect(models).toEqual([
      'authentik_flows.flow', 'authentik_stages_prompt.prompt', 'authentik_stages_prompt.promptstage', 'authentik_stages_email.emailstage',
      'authentik_stages_user_write.userwritestage', 'authentik_policies_expression.expressionpolicy',
      'authentik_flows.flowstagebinding', 'authentik_flows.flowstagebinding', 'authentik_policies.policybinding', 'authentik_flows.flowstagebinding',
    ]);
    const emailBinding = entries.find((e) => /id: email-binding/.test(e))!;
    expect(emailBinding).toMatch(/evaluate_on_plan: false/);
    expect(emailBinding).toMatch(/re_evaluate_policies: true/);
    expect(emailBinding).toMatch(/order: 20/);
    const policyBinding = entries.find((e) => e.startsWith('authentik_policies.policybinding'))!;
    expect(policyBinding).toMatch(/policy: !KeyOf to-new-address/);
    expect(policyBinding).toMatch(/target: !KeyOf email-binding/);
    expect(text).toMatch(/plan\.context\["pending_user"\] = request\.user/);
    expect(text).toMatch(/plan\.context\["email"\] = context\["prompt_data"\]\["email"\]/);
    expect(text).toMatch(/token_expiry: minutes=30/);
    // the template: the first line (a comment, so it never reaches the mail) names the owner-specific link, which is the button's only
    // link; a bare first line before {% extends %} would be dropped by Django and leave the button on the placeholder host
    const tpl = readFileSync(new URL('../../deploy/authentik/templates/friendflix-email-change.html', import.meta.url), 'utf8');
    const LINK = 'https://friend.example.com/confirm-email?token={{ token }}';
    expect(tpl.split('\n')[0]).toBe(`{# FriendFlix: the one value to replace is the app address in the link below: ${LINK} #}`);
    expect(tpl.match(/href="[^"]*"/g)).toEqual([`href="${LINK}"`]);
    // nothing but one-line comments before {% extends %}
    const head = tpl.split('{% extends')[0]!.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(head.every((l) => l.startsWith('{#') && l.endsWith('#}'))).toBe(true);
    expect(tpl).toContain('{% extends "email/base.html" %}');
    expect(tpl).toContain('{% trans ');
  });
});
