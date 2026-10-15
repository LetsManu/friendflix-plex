// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The sign-in status check (Block 23 phase 3, Admin → Status → Sign-in): are the Authentik flows the in-app login drives there, and
 * of a kind FriendFlix can show? Is the provider set up for the authorization-code grant with implicit consent? Does the issuer sit on
 * the Authentik address, and can passkeys run on the app's own host? A failing check never changes the sign-in mode; it is a warning
 * the card shows. Answers are codes: the texts live in the web locales.
 *
 * Flow stages are classified by `stage_obj.meta_model_name` (authentik.ts `akFlowStages`), never by the admin form's component name.
 * The result is cached for 10 minutes in kv under a hash of its inputs.
 */
import { akFlowStages, akOauthProvider, type FlowStages } from './authentik.js';
import { loginUi, flowSlug, passkeysStatus, type FlowKind, type PasskeysReason } from './akflow.js';
import type { Ctx } from './ctx.js';
import { secretTag } from './crypto.js';

type CheckCtx = Pick<Ctx, 'cfg' | 'kv' | 'db' | 'fetchImpl'>;

/** the stage models the app has a screen (or an automatic answer) for */
export const SUPPORTED_STAGES: ReadonlySet<string> = new Set([
  'authentik_stages_identification.identificationstage', 'authentik_stages_password.passwordstage',
  'authentik_stages_authenticator_validate.authenticatorvalidatestage', 'authentik_stages_authenticator_totp.authenticatortotpstage',
  'authentik_stages_authenticator_static.authenticatorstaticstage', 'authentik_stages_authenticator_webauthn.authenticatorwebauthnstage',
  'authentik_stages_email.emailstage', 'authentik_stages_prompt.promptstage', 'authentik_stages_user_login.userloginstage',
  'authentik_stages_user_write.userwritestage', 'authentik_stages_invitation.invitationstage', 'authentik_stages_deny.denystage',
  'authentik_stages_user_logout.userlogoutstage',
]);
const CONSENT_STAGE = 'authentik_stages_consent.consentstage';

export type CheckedKind = FlowKind | 'invalidation';
export interface FlowCheckRow { kind: CheckedKind; slug: string; state: 'ok' | 'missing' | 'unsupported'; stages: string[] }
export interface LoginCheck {
  mode: 'app' | 'authentik';
  flows: FlowCheckRow[];
  implicitConsent: boolean | null;
  authCodeGrant: boolean | null;
  issuerMatches: boolean;
  passkeys: 'in-app' | 'sign-in page';
  passkeysReason: PasskeysReason;
  /** Authentik did not answer (some rows are unknown); the card says so instead of calling flows missing */
  unreachable: boolean;
  /** codes of everything to look at; empty = all good */
  warnings: string[];
}

const TTL_S = 600;
const UNREACHABLE_TTL_S = 60;
/** the flows the in-app login drives, in the order the card lists them (the e-mail change flow: prompt, e-mail, user write; Task 10) */
const KINDS: readonly CheckedKind[] = ['login', 'recovery', 'enroll', 'invalidation', 'setup-totp', 'setup-static', 'setup-webauthn', 'change-password', 'change-email'];

const slugOf = (cfg: Ctx['cfg'], kind: CheckedKind): string | undefined =>
  kind === 'invalidation' ? cfg.AUTHENTIK_INVALIDATION_FLOW || 'default-invalidation-flow' : flowSlug(cfg, kind);

const originOf = (url: string | undefined): string | null => {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
};

export async function checkLoginFlows(ctx: CheckCtx): Promise<LoginCheck> {
  const cfg = ctx.cfg;
  const slugs = KINDS.map((k) => slugOf(cfg, k) ?? '');
  const key = `flowcheck:${secretTag(cfg.AUTHENTIK_API_TOKEN)}:${[cfg.AUTHENTIK_URL, cfg.OIDC_CLIENT_ID, cfg.OIDC_ISSUER, cfg.PUBLIC_URL, cfg.PASSKEYS_IN_APP, cfg.LOGIN_UI, ...slugs].map((v) => encodeURIComponent(v ?? '')).join('|')}`;
  const hit = await ctx.kv.get(key);
  if (hit) {
    try {
      return JSON.parse(hit) as LoginCheck;
    } catch { /* a damaged entry: check again */ }
  }
  const result = await run(ctx);
  await ctx.kv.set(key, JSON.stringify(result), result.unreachable ? UNREACHABLE_TTL_S : TTL_S);
  return result;
}

async function run(ctx: CheckCtx): Promise<LoginCheck> {
  const cfg = ctx.cfg;
  const mode = loginUi(cfg);
  const passkeys = await passkeysStatus(ctx);
  const base = {
    mode,
    issuerMatches: originOf(cfg.OIDC_ISSUER) !== null && originOf(cfg.OIDC_ISSUER) === originOf(cfg.AUTHENTIK_URL),
    passkeys: passkeys.inApp ? ('in-app' as const) : ('sign-in page' as const),
    passkeysReason: passkeys.reason,
  };
  // no Authentik API: nothing to read, the classic sign-in page is the only mode
  if (!cfg.AUTHENTIK_URL || !cfg.AUTHENTIK_API_TOKEN) {
    return { ...base, mode: 'authentik', flows: [], implicitConsent: null, authCodeGrant: null, unreachable: false, warnings: [] };
  }
  let unreachable = false;
  const flows: FlowCheckRow[] = [];
  for (const kind of KINDS) {
    const slug = slugOf(cfg, kind);
    if (!slug) continue; // enrolment without AUTHENTIK_ENROLL_FLOW: not used
    const f = await akFlowStages(ctx, slug);
    if (f.failed) unreachable = true;
    flows.push(row(kind, slug, f));
  }
  const found = cfg.OIDC_CLIENT_ID ? await akOauthProvider(ctx, cfg.OIDC_CLIENT_ID) : null;
  const providerDenied = found === 'forbidden';
  const provider = providerDenied ? null : found;
  let implicitConsent: boolean | null = null;
  if (provider?.authorizationFlow) {
    const auth = await akFlowStages(ctx, provider.authorizationFlow);
    if (auth.failed) unreachable = true;
    else if (auth.exists) implicitConsent = !auth.stages.some((s) => s.model === CONSENT_STAGE);
  }
  const authCodeGrant = provider?.grantTypes ? provider.grantTypes.includes('authorization_code') : null;

  const warnings: string[] = [];
  if (unreachable) warnings.push('unreachable');
  for (const r of flows) {
    // an optional flow that is not there only matters when the app would use it (login and recovery are always used in app mode)
    // the e-mail change flow is imported by hand (optional): without it the account page just hides "Change"
    if (r.state === 'missing' && !unreachable && r.kind !== 'change-email') warnings.push(`flow_missing:${r.kind}`);
    if (r.state === 'unsupported') warnings.push(`flow_unsupported:${r.kind}`);
  }
  // a permission the token lacks: the checks behind it cannot run, which must not look like a pass
  if (providerDenied) warnings.push('permission:provider');
  const loginRow = flows.find((r) => r.kind === 'login');
  if (loginRow && (await akFlowStages(ctx, loginRow.slug)).stageDenied) warnings.push('permission:validate_stage');
  if (implicitConsent === false) warnings.push('consent');
  if (authCodeGrant === false) warnings.push('auth_code_grant');
  if (!base.issuerMatches) warnings.push('issuer');
  if (base.passkeys === 'sign-in page' && passkeys.reason !== 'disabled') warnings.push(`passkeys:${passkeys.reason}`);
  return { ...base, flows, implicitConsent, authCodeGrant, unreachable, warnings };
}

function row(kind: CheckedKind, slug: string, f: FlowStages): FlowCheckRow {
  const stages = f.stages.map((s) => s.model);
  if (!f.exists) return { kind, slug, state: 'missing', stages: [] };
  return { kind, slug, state: stages.some((m) => !SUPPORTED_STAGES.has(m)) ? 'unsupported' : 'ok', stages };
}
