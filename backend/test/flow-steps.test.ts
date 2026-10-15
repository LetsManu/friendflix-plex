// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// The challenge sanitiser (Block 23 phase 3, Task 2): recorded Authentik 2026.8.3 challenges in, allow-listed step DTOs out.
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Jar, RawChallenge } from '../src/akflow.js';
import { FlowFieldError, maskEmail, RP_NAME, stepErrors, toAnswer, toStep } from '../src/flowSteps.js';
import { HttpError } from '../src/users.js';
import { fixture } from './akflow-fake.js';

const APP = 'friend.example.com';
const STEP = 'step-0001';

const jar = (over: Partial<Jar> = {}): Jar => ({
  cookies: {}, slug: 'default-authentication-flow', query: 'next=%2F', kind: 'login', createdAt: Date.now(), step: STEP,
  challenges: 1, forwardHost: true, identifier: 'anna@example.com', ...over,
});
const fx = (name: string, patch: Record<string, unknown> = {}): RawChallenge => ({ ...fixture(name), ...patch });
const step = (raw: RawChallenge, j: Partial<Jar> = {}, host: string | null = APP) => toStep(raw, jar(j), STEP, host);

/** a well-formed credential as the web sends it (fake values) */
const cred = (over: Record<string, unknown> = {}) => ({
  id: 'fake-cred-0001', rawId: 'fake-cred-0001', type: 'public-key',
  response: { clientDataJSON: 'fake-client-data', authenticatorData: 'fake-auth-data', signature: 'fake-sig', userHandle: null },
  clientExtensionResults: {}, authenticatorAttachment: 'platform', ...over,
});
const badRequest = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).statusCode).toBe(400);
    expect((e as HttpError).message).toBe('bad_request');
    return;
  }
  throw new Error('expected bad_request');
};

describe('toStep', () => {
  it('identification maps without urls', () => {
    expect(step(fixture('identification'))).toEqual({ stage: 'identify', step: STEP, passwordInline: false, canRecover: false, canEnroll: false, passkey: null });
    const s = step(fixture('identification-passkey'), { forwardHost: false });
    expect(s).toEqual({ stage: 'identify', step: STEP, passwordInline: true, canRecover: true, canEnroll: true, passkey: null });
    expect(JSON.stringify(s)).not.toMatch(/flows|if\/flow|next=/);
  });

  it('identification without user fields (sources only) → classic', () => {
    expect(step(fx('identification', { user_fields: [] }))).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
  });

  it('password keeps the typed identifier as identity, not pending_user_avatar', () => {
    const s = step(fixture('password'), { identifier: 'anna@example.com' });
    expect(s).toEqual({ stage: 'password', step: STEP, identity: 'anna@example.com', canRecover: false });
    expect(JSON.stringify(s)).not.toMatch(/data:|avatar|"anna"/);
    expect(step(fx('password', { recovery_url: '/flows/-/default/recovery/' }), { identifier: undefined })).toEqual({ stage: 'password', step: STEP, identity: '', canRecover: true });
  });

  it('validate with totp+static+webauthn, forwardHost and rpId = app host → mfa {totp, recovery, passkey: options, passkeyClassic: false}', () => {
    const raw = fixture('validate-all');
    ((raw.device_challenges as Array<{ challenge: { rpId?: string } }>)[2]!.challenge).rpId = APP;
    expect(step(raw)).toEqual({
      stage: 'mfa', step: STEP, totp: true, recovery: true, passkeyClassic: false,
      passkey: { challenge: 'fake-challenge-0001', rpId: APP, allowCredentials: [{ id: 'fake-id-0002', type: 'public-key' }], userVerification: 'preferred', timeout: 60000 },
    });
    expect(step(fixture('validate-webauthn'))).toMatchObject({ stage: 'mfa', totp: false, recovery: true, passkey: { rpId: APP }, passkeyClassic: false });
  });

  it("validate with webauthn whose rpId is Authentik's host → passkey null, passkeyClassic true", () => {
    expect(step(fixture('validate-all'))).toEqual({ stage: 'mfa', step: STEP, totp: true, recovery: true, passkey: null, passkeyClassic: true });
    expect(step(fixture('validate-webauthn-unforwarded'))).toMatchObject({ stage: 'mfa', recovery: true, passkey: null, passkeyClassic: true });
    // the right rpId but a jar that does not forward the host (or no app host yet): never in-app
    expect(step(fixture('validate-webauthn'), { forwardHost: false })).toMatchObject({ passkey: null, passkeyClassic: true });
    expect(step(fixture('validate-webauthn'), {}, null)).toMatchObject({ passkey: null, passkeyClassic: true });
  });

  it('validate with only webauthn and a wrong rpId → classic passkey_origin', () => {
    const only = (rpId: string) => {
      const raw = fixture('validate-webauthn-unforwarded');
      raw.device_challenges = (raw.device_challenges as Array<{ device_class: string; challenge: Record<string, unknown> }>)
        .filter((d) => d.device_class === 'webauthn').map((d) => ({ ...d, challenge: { ...d.challenge, rpId } }));
      return raw;
    };
    expect(step(only('auth.example.com'))).toEqual({ stage: 'classic', reason: 'passkey_origin' });
    expect(step(only(APP))).toMatchObject({ stage: 'mfa', totp: false, recovery: false, passkey: { rpId: APP }, passkeyClassic: false });
    // a malformed webauthn challenge counts as unusable
    const broken = only(APP);
    (broken.device_challenges as Array<{ challenge: unknown }>)[0]!.challenge = { challenge: 'not base64url!', rpId: APP };
    expect(step(broken)).toEqual({ stage: 'classic', reason: 'passkey_origin' });
  });

  it('identification passkey_challenge with app rpId → identify.passkey set; without forwardHost → null', () => {
    expect(step(fixture('identification-passkey'))).toEqual({
      stage: 'identify', step: STEP, passwordInline: true, canRecover: true, canEnroll: true,
      passkey: { challenge: 'fake-challenge-0011', rpId: APP, allowCredentials: [], userVerification: 'preferred', timeout: 60000 },
    });
    expect(step(fixture('identification-passkey'), { forwardHost: false })).toMatchObject({ stage: 'identify', passkey: null });
    const other = fixture('identification-passkey');
    (other.passkey_challenge as { rpId: string }).rpId = 'auth.example.com';
    expect(step(other)).toMatchObject({ stage: 'identify', passkey: null });
    // a passkey on a sources-only identification keeps the step usable
    expect(step({ ...fixture('identification-passkey'), user_fields: [] })).toMatchObject({ stage: 'identify', passkey: { rpId: APP } });
  });

  it('webauthn setup with app rp.id → passkey-setup; otherwise classic passkey_origin', () => {
    const s = step(fixture('webauthn-setup'), { kind: 'setup-webauthn' });
    expect(s).toEqual({
      stage: 'passkey-setup', step: STEP,
      options: {
        challenge: 'fake-challenge-0008', rp: { id: APP, name: RP_NAME }, user: { id: 'fake-id-0007', name: 'anna', displayName: 'Anna Beispiel' },
        pubKeyCredParams: [{ type: 'public-key', alg: -8 }, { type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        excludeCredentials: [], authenticatorSelection: { residentKey: 'preferred', requireResidentKey: false, userVerification: 'preferred' },
        attestation: 'direct', timeout: 60000,
      },
    });
    expect(step(fixture('webauthn-setup-unforwarded'), { kind: 'setup-webauthn' })).toEqual({ stage: 'classic', reason: 'passkey_origin' });
    expect(step(fixture('webauthn-setup'), { kind: 'setup-webauthn', forwardHost: false })).toEqual({ stage: 'classic', reason: 'passkey_origin' });
    // unknown option keys are not passed on; malformed options are never a ceremony
    const extra = fixture('webauthn-setup');
    Object.assign(extra.registration as object, { extensions: { credProps: true }, hints: ['https://evil.example.com'] });
    (extra.registration as { excludeCredentials: unknown[] }).excludeCredentials = [{ id: 'fake-id-0099', type: 'public-key', transports: ['internal', 'x-bogus'] }];
    expect(step(extra)).toMatchObject({ stage: 'passkey-setup', options: { excludeCredentials: [{ id: 'fake-id-0099', type: 'public-key', transports: ['internal'] }] } });
    expect(JSON.stringify(step(extra))).not.toMatch(/extensions|hints|evil|bogus/);
    for (const bad of [
      { user: { id: 'fake-id-0007', name: 'anna' } },
      { pubKeyCredParams: [{ type: 'other', alg: -7 }] },
      { excludeCredentials: [{ id: 'fake-id-0099', type: 'other' }] },
      { challenge: 'https://auth.example.com/' },
    ]) {
      const r = fixture('webauthn-setup');
      Object.assign(r.registration as object, bad);
      expect(step(r)).toEqual({ stage: 'classic', reason: 'passkey_origin' });
    }
    expect(step(fx('webauthn-setup', { registration: null }))).toEqual({ stage: 'classic', reason: 'passkey_origin' });
  });

  it('email link consent in a recovery-resume jar → internal link-confirm; consent with permissions or in a login jar → classic consent', () => {
    const resume = { kind: 'recovery-resume' as const, query: 'flow_token=fake-flow-token-0001', challenges: 1 };
    expect(step(fixture('consent-link'), resume)).toEqual({ internal: 'link-confirm', token: '00000000-0000-4000-8000-000000000001', pendingUser: 'anna' });
    expect(step(fixture('consent-link'), { ...resume, kind: 'email-confirm' })).toMatchObject({ internal: 'link-confirm' });
    expect(step(fx('consent-link', { pending_user: '' }), resume)).toEqual({ internal: 'link-confirm', token: '00000000-0000-4000-8000-000000000001' });
    // a pending user longer than any username is dropped (Task 2 review: bounded before it becomes a counter key or a lookup)
    expect(step(fx('consent-link', { pending_user: 'a'.repeat(254) }), resume)).toMatchObject({ pendingUser: 'a'.repeat(254) });
    expect(step(fx('consent-link', { pending_user: 'a'.repeat(255) }), resume)).toEqual({ internal: 'link-confirm', token: '00000000-0000-4000-8000-000000000001' });
    const consent = { stage: 'classic', reason: 'consent' };
    expect(step(fx('consent-link', { permissions: [{ name: 'profile', id: 'profile' }] }), resume)).toEqual(consent);
    expect(step(fx('consent-link', { additional_permissions: [{ name: 'email', id: 'email' }] }), resume)).toEqual(consent);
    expect(step(fx('consent-link', { additional_permissions: undefined }), resume)).toEqual(consent);
    expect(step(fixture('consent-link'), { ...resume, kind: 'login' })).toEqual(consent);
    expect(step(fixture('consent-link'), { ...resume, query: 'next=%2F' })).toEqual(consent);
    // a consent later in the jar (a replay mid-flow) is never auto-answered
    expect(step(fixture('consent-link'), { ...resume, challenges: 2 })).toEqual(consent);
    expect(step(fx('consent-link', { token: 'bad token' }), resume)).toEqual(consent);
  });

  it('email-sent masks the typed address, the new address for an e-mail change, and omits a username', () => {
    expect(step(fixture('email-sent'), { kind: 'recovery' })).toEqual({ stage: 'email-sent', step: STEP, to: 'a•••@example.com' });
    expect(step(fixture('email-sent'), { kind: 'recovery', identifier: 'anna' })).toEqual({ stage: 'email-sent', step: STEP, to: null });
    expect(step(fixture('email-sent'), { kind: 'recovery', identifier: undefined })).toEqual({ stage: 'email-sent', step: STEP, to: null });
    const j = jar({ kind: 'change-email', identifier: 'anna' });
    expect(toStep(fixture('email-sent'), j, STEP, APP, 'Bert.New@Example.org')).toEqual({ stage: 'email-sent', step: STEP, to: 'B•••@example.org' });
    expect(toStep(fixture('email-sent'), j, STEP, APP)).toEqual({ stage: 'email-sent', step: STEP, to: null });
  });

  it('access denied → denied, without Authentik text', () => {
    expect(step(fixture('access-denied'))).toEqual({ stage: 'denied' });
  });

  it('validate with only sms → classic', () => {
    expect(step(fixture('validate-sms'))).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
    for (const cls of ['duo', 'email']) {
      expect(step(fx('validate-sms', { device_challenges: [{ device_class: cls, device_uid: '5', challenge: {}, last_used: null }] }))).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
    }
    // sms next to a passkey for another host: still the classic page
    const mixed = fixture('validate-webauthn-unforwarded');
    mixed.device_challenges = [...(mixed.device_challenges as unknown[]).slice(1), { device_class: 'sms', device_uid: '4', challenge: {}, last_used: null }];
    expect(step(mixed)).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
    // sms next to a usable TOTP: the TOTP screen
    expect(step(fx('validate-sms', { device_challenges: [{ device_class: 'sms', device_uid: '4', challenge: {} }, { device_class: 'totp', device_uid: '3', challenge: {} }] })))
      .toMatchObject({ stage: 'mfa', totp: true, recovery: false, passkey: null, passkeyClassic: false });
  });

  it('validate without devices offering TOTP setup → internal select-stage; otherwise classic', () => {
    expect(step(fixture('validate-configure'))).toEqual({ internal: 'select-stage', pk: '00000000-0000-4000-8000-0000000000a1' });
    expect(step(fx('validate-configure', { configuration_stages: [{ pk: 'x1', meta_model_name: 'authentik_stages_authenticator_webauthn.authenticatorwebauthnstage' }] })))
      .toEqual({ stage: 'classic', reason: 'unsupported_stage' });
    expect(step(fx('validate-configure', { configuration_stages: [] }))).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
    expect(step(fx('validate-configure', { configuration_stages: undefined, device_challenges: undefined }))).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
  });

  it('captcha → classic', () => {
    expect(step(fixture('identification-captcha'))).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
  });

  it('unknown component → classic unsupported_stage', () => {
    for (const component of ['ak-stage-flow-error', 'xak-flow-shell', 'ak-stage-user-login', 'ak-source-plex', '']) {
      expect(step({ component, body: '<script>alert(1)</script>', to: 'https://evil.example.com/' })).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
    }
  });

  it('final redirect → end', () => {
    expect(step(fixture('redirect-final'))).toEqual({ internal: 'end' });
    expect(step(fixture('invalidation-end'))).toEqual({ internal: 'end' });
    for (const to of ['/', '/if/user/', '/application/o/authorize/?client_id=x']) expect(step({ component: 'xak-flow-redirect', to })).toEqual({ internal: 'end' });
    for (const to of ['https://evil.example.com/', '//evil.example.com/', '/if/flow/other/', '/if/user/#/settings', undefined]) {
      expect(step({ component: 'xak-flow-redirect', to, final_redirect: false })).toEqual({ stage: 'classic', reason: 'external_redirect' });
    }
  });

  it('prompt maps shown fields with FriendFlix labels for passwords, and skips static text', () => {
    expect(step(fixture('prompt-password-change'), { kind: 'change-password' })).toEqual({
      stage: 'prompt', step: STEP, fields: [
        { key: 'password', type: 'password', label: 'ff:password', required: true },
        { key: 'password_repeat', type: 'password', label: 'ff:password_repeat', required: true },
      ],
    });
    const enroll = step(fixture('prompt-enroll'), { kind: 'enroll' });
    expect(enroll).toMatchObject({ stage: 'prompt', fields: [
      { key: 'username', type: 'username', label: 'Username', required: true },
      { key: 'name', type: 'text', label: 'Name', required: true },
      { key: 'email', type: 'email', label: 'Email', required: true },
      { key: 'password', label: 'ff:password' }, { key: 'password_repeat', label: 'ff:password_repeat' },
    ] });
    expect(JSON.stringify(enroll)).not.toMatch(/rules|<b>|notice|sep"/);
    // the e-mail change's single field gets FriendFlix's label
    const change = fx('prompt-enroll', { fields: [{ field_key: 'email', label: 'New e-mail address', type: 'email', required: true }] });
    expect(step(change, { kind: 'change-email' })).toEqual({ stage: 'prompt', step: STEP, fields: [{ key: 'email', type: 'email', label: 'ff:new_email', required: true }] });
    // Authentik labels are plain text only: a label with markup or a URL (or none) falls back to the key
    const labels = fx('prompt-enroll', { fields: [
      { field_key: 'name', label: '<i>Your</i>\n name', type: 'text' },
      { field_key: 'nick', label: 'see https://auth.example.com/x', type: 'text', required: false },
      { field_key: 'city', type: 'text' },
      { field_key: 'zip', label: '<scr<x>ipt>Zip', type: 'text' },
    ] });
    expect(step(labels, { kind: 'enroll' })).toEqual({ stage: 'prompt', step: STEP, fields: [
      { key: 'name', type: 'text', label: 'name', required: false },
      { key: 'nick', type: 'text', label: 'nick', required: false },
      { key: 'city', type: 'text', label: 'city', required: false },
      { key: 'zip', type: 'text', label: 'zip', required: false },
    ] });
  });

  it('prompt with a date field → classic', () => {
    for (const type of ['date', 'hidden', 'file', 'checkbox', 'dropdown', 'text_area']) {
      const raw = fixture('prompt-enroll');
      (raw.fields as unknown[]).push({ field_key: 'birthday', label: 'Birthday', type, required: false });
      expect(step(raw, { kind: 'enroll' })).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
    }
    expect(step(fx('prompt-enroll', { fields: [{ field_key: 'a b', label: 'x', type: 'text' }] }))).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
    expect(step(fx('prompt-enroll', { fields: [{ field_key: 'notice', label: 'Hi', type: 'static' }] }))).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
    expect(step(fx('prompt-enroll', { fields: ['x'] }))).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
    expect(step(fx('prompt-enroll', { fields: undefined }))).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
  });

  it('totp setup passes only otpauth', () => {
    const s = step(fixture('totp-setup'), { kind: 'setup-totp' });
    expect(s).toEqual({ stage: 'totp-setup', step: STEP, otpauth: 'otpauth://totp/authentik%3Aanna?secret=FAKESECRETFAKESECRETFAKESECRETAA&algorithm=SHA1&digits=6&period=30&issuer=authentik' });
    expect(Object.keys(s)).toEqual(['stage', 'step', 'otpauth']);
    // unknown parameters (an image URL) are dropped; anything but a TOTP URI is never passed on
    const img = fx('totp-setup', { config_url: 'otpauth://totp/x%3Aanna?secret=FAKESECRETFAKESECRETFAKESECRETAA&image=https%3A%2F%2Fauth.example.com%2Fa.png&digits=7' });
    expect(step(img)).toEqual({ stage: 'totp-setup', step: STEP, otpauth: 'otpauth://totp/x%3Aanna?secret=FAKESECRETFAKESECRETFAKESECRETAA' });
    for (const config_url of ['https://auth.example.com/otp', 'otpauth://hotp/x?secret=FAKESECRETFAKESECRETFAKESECRETAA', 'otpauth://totp/x?secret=not-base32', 'otpauth://totp/x?digits=6', 42]) {
      expect(step(fx('totp-setup', { config_url }))).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
    }
  });

  it('static setup passes only the codes', () => {
    expect(step(fixture('static-setup'), { kind: 'setup-static' })).toEqual({ stage: 'recovery-codes', step: STEP, codes: ['fakecode0001', 'fakecode0002', 'fakecode0003', 'fakecode0004', 'fakecode0005', 'fakecode0006'] });
    expect(step(fx('static-setup', { codes: ['fakecode0001', '<b>x</b>'] }))).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
    expect(step(fx('static-setup', { codes: [] }))).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
    expect(step(fx('static-setup', { codes: undefined }))).toEqual({ stage: 'classic', reason: 'unsupported_stage' });
  });

  it('no-leak: no fixture DTO carries an Authentik URL, token, avatar or internal id', () => {
    const names = readdirSync(new URL('./fixtures/akflow/', import.meta.url)).filter((f) => f.endsWith('.json') && !f.startsWith('exchange-')).map((f) => f.slice(0, -5));
    expect(names.length).toBeGreaterThanOrEqual(29);
    const jars: Array<Partial<Jar>> = [
      {}, { forwardHost: false }, { kind: 'recovery-resume', query: 'flow_token=fake-flow-token-0001' }, { kind: 'change-email' }, { kind: 'setup-webauthn' },
    ];
    for (const name of names) {
      for (const j of jars) {
        const out = step(fixture(name), j);
        if ('internal' in out) continue; // internal outcomes never reach the browser
        const json = JSON.stringify(out);
        if (out.stage === 'totp-setup') {
          // Ruling 2: the user's own new secret as an otpauth:// URI (its issuer is the brand); nothing else
          expect(json).not.toMatch(/https?:\/\/|flow_token|cancel_url|avatar/);
          continue;
        }
        expect(json, name).not.toMatch(/https?:\/\//);
        expect(json, name).not.toMatch(/authentik/i);
        expect(json, name).not.toMatch(/flow_token|cancel_url|avatar|pending_user|device_uid|csrf|session|background|\/static\/|\/flows\//);
        expect(json, name).not.toMatch(/auth\.example\.com/); // a passkey rpId / rp.id is the app host, never Authentik's
        expect(json, name).not.toMatch(/00000000-0000-4000-8000/); // stage pks and consent tokens stay internal
      }
    }
  });
});

describe('stepErrors', () => {
  it('response_errors map to codes', () => {
    expect(stepErrors(fixture('password-invalid'))).toEqual(['invalid']);
    expect(stepErrors(fixture('validate-code-invalid'))).toEqual(['code_invalid']);
    expect(stepErrors(fixture('totp-setup-invalid'))).toEqual(['code_invalid']);
    expect(stepErrors(fixture('prompt-mismatch'))).toEqual(['invalid']);
    expect(stepErrors(fixture('password'))).toEqual([]);
    expect(stepErrors({ component: 'ak-stage-prompt', response_errors: { username: [{ string: 'This field is required.', code: 'required' }, { code: 'unique' }], email: [{ code: 'invalid' }], x: 'odd' as never, y: [null as never] } }))
      .toEqual(['required', 'invalid']);
    expect(stepErrors({ component: 'ak-stage-identification', response_errors: [] as never })).toEqual([]);
  });

  it('email-sent resend error is not an error', () => {
    expect(stepErrors(fixture('email-resent'))).toEqual([]);
    expect(stepErrors(fixture('email-sent'))).toEqual([]);
  });
});

describe('maskEmail', () => {
  it('masks the local part and keeps the domain', () => {
    expect(maskEmail('anna@example.com')).toBe('a•••@example.com');
    expect(maskEmail(' Anna.B@Example.COM ')).toBe('A•••@example.com');
    expect(maskEmail('ö@bücher.example')).toBe('ö•••@bücher.example');
    expect(maskEmail('"x"@example.com')).toBe('•••@example.com');
    for (const v of ['anna', '@example.com', 'anna@', 'anna@localhost', 'anna@exa mple.com', `${'a'.repeat(250)}@example.com`]) expect(maskEmail(v)).toBeNull();
  });
});

describe('toAnswer', () => {
  it('identify: identifier (+ inline password) or a passkey', () => {
    expect(toAnswer('identify', { identifier: 'anna' }, fixture('identification'))).toEqual({ uid_field: 'anna' });
    expect(toAnswer('identify', { identifier: 'anna', password: 'pw' }, fixture('identification-passkey'))).toEqual({ uid_field: 'anna', password: 'pw' });
    expect(toAnswer('identify', { passkey: cred() }, fixture('identification-passkey'))).toEqual({ passkey: cred() });
    badRequest(() => toAnswer('identify', { passkey: cred() }, fixture('identification'))); // no passkey challenge to answer
  });

  it('password, mfa, passkey-setup, totp-setup, recovery-codes and email-sent', () => {
    expect(toAnswer('password', { password: 'pw' }, fixture('password'))).toEqual({ password: 'pw' });
    expect(toAnswer('mfa', { code: '123456' }, fixture('validate-all'))).toEqual({ code: '123456' });
    expect(toAnswer('mfa', { code: 'fakecode0001' }, fixture('validate-all'))).toEqual({ code: 'fakecode0001' });
    expect(toAnswer('mfa', { webauthn: cred() }, fixture('validate-webauthn'))).toEqual({ webauthn: cred() });
    badRequest(() => toAnswer('mfa', { webauthn: cred() }, fixture('validate-code-invalid'))); // no webauthn device
    badRequest(() => toAnswer('mfa', { webauthn: cred() }, fx('validate-code-invalid', { device_challenges: undefined })));
    const reg = cred({ response: { clientDataJSON: 'ZmFrZQ', attestationObject: 'fake-att', transports: ['internal', 'hybrid'] } });
    expect(toAnswer('passkey-setup', { response: reg }, fixture('webauthn-setup'))).toEqual({ response: reg });
    expect(toAnswer('totp-setup', { code: '654321' }, fixture('totp-setup'))).toEqual({ code: '654321' });
    expect(toAnswer('recovery-codes', {}, fixture('static-setup'))).toEqual({});
    expect(toAnswer('email-sent', undefined, fixture('email-sent'))).toEqual({});
  });

  it('prompt password mismatch → password_mismatch without an Authentik call', () => {
    const raw = fixture('prompt-recovery');
    expect(toAnswer('prompt', { password: 'new-pass-1', password_repeat: 'new-pass-1' }, raw)).toEqual({ password: 'new-pass-1', password_repeat: 'new-pass-1' });
    let err: unknown;
    try {
      toAnswer('prompt', { password: 'new-pass-1', password_repeat: 'new-pass-2' }, raw);
    } catch (e) {
      err = e;
    }
    // toAnswer is synchronous and pure: the route never reaches akExec; the error carries the browser's body
    expect(err).toBeInstanceOf(FlowFieldError);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as FlowFieldError).statusCode).toBe(400);
    expect((err as FlowFieldError).errors).toEqual(['password_mismatch']);
    expect((err as Error).message).toBe('password_mismatch');
    expect(JSON.stringify(err)).not.toMatch(/new-pass/);
    // only the shown fields, missing ones left for Authentik ('required')
    expect(toAnswer('prompt', { username: 'anna', email: 'anna@example.com' }, fixture('prompt-enroll'))).toEqual({ username: 'anna', email: 'anna@example.com' });
    expect(new FlowFieldError([]).message).toBe('invalid');
  });

  it('credential answers reject extra keys and oversize fields', () => {
    const raw = fixture('validate-webauthn');
    const big = 'A'.repeat(16 * 1024 + 1);
    for (const bad of [
      cred({ extra: 1 }),
      cred({ type: 'password' }),
      cred({ id: 'A'.repeat(1025) }),
      cred({ rawId: 'not/base64url' }),
      cred({ clientExtensionResults: { credProps: { rk: true } } }),
      cred({ response: { clientDataJSON: big } }),
      cred({ response: { clientDataJSON: 'ZmFrZQ', signature: big } }),
      cred({ response: { clientDataJSON: 'ZmFrZQ', html: '<b>' } }),
      cred({ response: { clientDataJSON: 'ZmFrZQ', transports: ['USB!'] } }),
      cred({ response: {} }),
    ]) {
      badRequest(() => toAnswer('mfa', { webauthn: bad }, raw));
      badRequest(() => toAnswer('passkey-setup', { response: bad }, fixture('webauthn-setup')));
      badRequest(() => toAnswer('identify', { passkey: bad }, fixture('identification-passkey')));
    }
  });

  it('toAnswer rejects extra keys and over-long values', () => {
    const cases: Array<[Parameters<typeof toAnswer>[0], unknown, string]> = [
      ['identify', { identifier: 'anna', uid_field: 'x' }, 'identification'],
      ['identify', { identifier: '' }, 'identification'],
      ['identify', { identifier: 'a'.repeat(255) }, 'identification'],
      ['identify', { identifier: 'anna', password: 'p'.repeat(1025) }, 'identification'],
      ['identify', { identifier: 'anna', passkey: cred() }, 'identification-passkey'],
      ['identify', 'anna', 'identification'],
      ['password', { password: 'pw', component: 'ak-stage-password' }, 'password'],
      ['password', { password: 'p'.repeat(1025) }, 'password'],
      ['password', {}, 'password'],
      ['mfa', { code: '12345' }, 'validate-all'],
      ['mfa', { code: '1234567' }, 'validate-all'],
      ['mfa', { code: 'abc-defg-hij' }, 'validate-all'],
      ['mfa', { code: 'a'.repeat(33) }, 'validate-all'],
      ['mfa', { code: '123456', selected_challenge: {} }, 'validate-all'],
      ['mfa', { code: '123456', webauthn: cred() }, 'validate-webauthn'],
      ['totp-setup', { code: 'fakecode0001' }, 'totp-setup'],
      ['recovery-codes', { ok: true }, 'static-setup'],
      ['email-sent', { email: 'anna@example.com' }, 'email-sent'],
      ['prompt', { password: 'x', password_repeat: 'x', is_superuser: true }, 'prompt-recovery'],
      ['prompt', { password: 'p'.repeat(1025) }, 'prompt-recovery'],
      ['prompt', { email: `${'a'.repeat(250)}@example.com` }, 'prompt-enroll'],
      ['prompt', { notice: 'x' }, 'prompt-enroll'], // a static field is not answerable
      ['prompt', { password: 5 }, 'prompt-recovery'],
      ['prompt', 'x', 'prompt-recovery'],
      ['prompt', {}, 'email-sent'], // a challenge without fields
      ['denied', {}, 'access-denied'],
      ['classic', {}, 'identification'],
      ['done', {}, 'redirect-final'],
      ['toString' as never, {}, 'identification'], // never a prototype key
    ];
    for (const [stage, body, name] of cases) badRequest(() => toAnswer(stage, body, fixture(name)));
  });
});
