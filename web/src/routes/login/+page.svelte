<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * /login (Block 23 phase 3): FriendFlix's own sign-in screens over the cover wall; Authentik's flow runs behind /auth/flow/*.
   * A public page (no /api/me): the layout leaves it alone and api() does not send its 401s to /auth/login.
   * - `GET /auth/flow/config` first: `authentik` mode → the classic redirect; during setup (503) → /setup; unreachable → "unavailable".
   * - Then `start {kind:'login'}` (with `?invite=`), and each answer's reply is the next screen. Only this page navigates: `done` →
   *   `next`, the sign-in page, an invite. The step components only emit events (they are reused in the re-auth dialog, T11).
   * - A stage this page has no screen for continues on the sign-in page ("Auf der Anmeldeseite fortfahren", keeping the invite).
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { publicLocale, setLocale, t } from '#lib/i18n';
  import AuthShell from '#lib/auth/AuthShell.svelte';
  import Identify from '#lib/auth/Identify.svelte';
  import Password from '#lib/auth/Password.svelte';
  import Mfa from '#lib/auth/Mfa.svelte';
  import Notice from '#lib/auth/Notice.svelte';
  import EmailSent from '#lib/auth/EmailSent.svelte';
  import PromptFields from '#lib/auth/PromptFields.svelte';
  import TotpSetup from '#lib/auth/TotpSetup.svelte';
  import RecoveryCodes from '#lib/auth/RecoveryCodes.svelte';
  import { cancelFlow, classicHref, flowConfig, FlowRefused, safeNext, startFlow, type FlowConfig, type FlowKind, type FlowReply } from '#lib/auth/flow';

  let cfg: FlowConfig | null = null;
  /** null while loading */
  let view: FlowReply | null = null;
  let invite = '';
  let inviteGone = false;
  /** `?invite=…&enroll=1`: the sign-up flow of an invite (the invite page links here in app mode) */
  let enrolling = false;
  /** `?reset=1`: the new password was set on /reset */
  let resetDone = false;
  let leaving = false;
  $: classic = classicHref(invite);
  /** notices the page shows for these stages; anything else without a screen here continues on the sign-in page */
  const SCREENS = new Set(['identify', 'password', 'mfa', 'email-sent', 'prompt', 'totp-setup', 'recovery-codes']);
  const NOTICES = new Set(['denied', 'locked', 'expired', 'unavailable', 'classic']);
  $: notice = view && NOTICES.has(view.stage) ? (view.stage as 'denied' | 'locked' | 'expired' | 'unavailable' | 'classic') : view && !SCREENS.has(view.stage) ? 'classic' : null;

  onMount(() => {
    const pre = publicLocale();
    if (pre) void setLocale(pre);
    const q = new URLSearchParams(location.search);
    const inv = q.get('invite') ?? '';
    invite = inv.length > 0 && inv.length <= 128 ? inv : '';
    enrolling = invite !== '' && q.get('enroll') === '1';
    resetDone = q.get('reset') === '1';
    void boot();
  });

  async function boot() {
    view = null;
    try {
      cfg = await flowConfig();
    } catch {
      cfg = null;
      view = { stage: 'unavailable' };
      return;
    }
    if (cfg.mode === 'authentik') return leave(classicHref(invite));
    await begin(enrolling ? 'enroll' : 'login');
  }

  /** a new attempt (also the retry after `unavailable`, "Neu starten" and "ändern") */
  async function begin(kind: FlowKind, extra: { identifier?: string } = {}) {
    if (!cfg) return boot();
    view = null;
    try {
      show(await startFlow(kind, (kind === 'login' || kind === 'enroll') && invite ? { invite } : extra));
    } catch (e) {
      if (e instanceof FlowRefused && invite) {
        // the invite is used up or withdrawn: say so, and sign in without it
        invite = '';
        enrolling = false;
        inviteGone = true;
        return begin('login');
      }
      view = { stage: 'unavailable' };
    }
  }

  /** "Zurück zur Anmeldung" on the inbox screen: gives the recovery attempt up and starts a fresh sign-in */
  async function backToSignIn() {
    view = null;
    await cancelFlow();
    await begin('login');
  }

  function show(r: FlowReply) {
    if (r.stage === 'done') leave(safeNext(r.next));
    else view = r;
  }
  function leave(to: string) {
    leaving = true;
    location.href = to;
  }
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('login.pageTitle') })}</title></svelte:head>
<AuthShell>
  {#if resetDone && view && !leaving}<p class="ok" role="status">{$t('login.reset.banner')}</p>{/if}
  {#if inviteGone}<p class="gone" role="status">{$t('login.inviteGone')}</p>{/if}
  {#if !view || leaving}
    <p class="loading muted" role="status">{$t('login.loading')}</p>
  {:else if notice}
    <Notice kind={notice} classicHref={classic} on:retry={() => begin(enrolling ? 'enroll' : 'login')} on:restart={() => begin(enrolling ? 'enroll' : 'login')} />
  {:else if view.stage === 'identify'}
    <Identify step={view} classicHref={classic} on:next={(e) => show(e.detail)} on:done={(e) => leave(safeNext(e.detail.next))}
      on:classic={() => leave(classic)} on:invite={(e) => goto(`/invite/${encodeURIComponent(e.detail.token)}`)} />
  {:else if view.stage === 'password'}
    <Password step={view} classicHref={classic} recovery={cfg?.recovery ?? false} on:next={(e) => show(e.detail)} on:done={(e) => leave(safeNext(e.detail.next))}
      on:restart={() => begin('login')} on:forgot={(e) => begin('recovery', { identifier: e.detail.identifier || undefined })} />
  {:else if view.stage === 'mfa'}
    <Mfa step={view} classicHref={classic} on:next={(e) => show(e.detail)} on:done={(e) => leave(safeNext(e.detail.next))} />
  {:else if view.stage === 'email-sent'}
    <EmailSent step={view} classicHref={classic} on:next={(e) => show(e.detail)} on:done={(e) => leave(safeNext(e.detail.next))} on:cancel={backToSignIn} />
  {:else if view.stage === 'prompt'}
    <PromptFields step={view} classicHref={classic} title={$t('login.enroll.title')} text={$t('login.enroll.text')} submitLabel={$t('login.enroll.submit')}
      on:next={(e) => show(e.detail)} on:done={(e) => leave(safeNext(e.detail.next))} />
  {:else if view.stage === 'totp-setup'}
    <TotpSetup step={view} classicHref={classic} on:next={(e) => show(e.detail)} on:done={(e) => leave(safeNext(e.detail.next))} />
  {:else if view.stage === 'recovery-codes'}
    <RecoveryCodes step={view} classicHref={classic} on:next={(e) => show(e.detail)} on:done={(e) => leave(safeNext(e.detail.next))} />
  {/if}
</AuthShell>

<style>
  .loading { margin: 0; text-align: center; padding: 1rem 0; }
  .ok { margin: 0 0 12px; padding: 10px 12px; border-radius: 10px; background: var(--tone-ok, rgba(46, 160, 100, .22)); font-size: .88rem; }
  .gone { margin: 0 0 12px; padding: 10px 12px; border-radius: 10px; background: var(--tone-warn); font-size: .88rem; }
</style>
