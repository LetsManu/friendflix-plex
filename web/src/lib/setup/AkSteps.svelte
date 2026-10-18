<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Step 4, automatic: the Authentik automation (spec Part G). "Show plan" only reads and lists every step with what it would do;
   * "Apply" runs them (about 30 s: a visible progress state and a long client timeout), then shows the results and the manual leftovers
   * (SMTP, MFA, /templates). The admin API token stays in the field between plan and apply and is emptied once apply has used it
   * (a retry asks for it again); it is never stored.
   */
  import { createEventDispatcher } from 'svelte';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import StatusPill, { type Tone } from '#lib/ui/StatusPill.svelte';
  import { uid } from '#lib/ui/ids';
  import { keyLabel } from '#lib/admin/settings/form';
  import { akApply, akPlan, isPlainHttp, type AkResult, type AkStep } from './api';
  import { akFailText, failedStep, type Handle } from './messages';
  import Notice from './Notice.svelte';

  export let handle: Handle;
  const dispatch = createEventDispatcher<{ done: void }>();
  const id = uid('ak');

  let url = '', token = '', addMe = true;
  let plan: AkStep[] | null = null;
  let result: AkResult | null = null;
  let busy: 'plan' | 'apply' | null = null;
  let msg = '';

  const TONE: Record<AkStep['state'], Tone> = { create: 'info', update: 'warn', exists: 'muted', skip: 'muted', ok: 'ok', failed: 'err' };
  const ICON: Record<AkStep['state'], string> = { create: 'plus', update: 'refresh', exists: 'check', skip: 'x', ok: 'check', failed: 'alert' };
  $: planFailed = plan ? failedStep(plan) : null;
  $: applyFailed = result && !result.ok ? failedStep(result.steps) : null;
  $: ready = Boolean(url.trim() && token.trim());

  /** another address makes the plan and the result stale */
  function urlChanged() { plan = null; result = null; msg = ''; }

  async function showPlan() {
    if (busy || !ready) return;
    busy = 'plan'; msg = ''; result = null;
    try {
      plan = (await akPlan({ url: url.trim(), token: token.trim() })).steps;
    } catch (e) {
      plan = null;
      msg = handle(e)?.text ?? '';
    } finally { busy = null; }
  }

  async function apply() {
    if (busy || !ready) return;
    busy = 'apply'; msg = '';
    try {
      result = await akApply({ url: url.trim(), token: token.trim(), addMeToAdmins: addMe });
    } catch (e) {
      const f = handle(e);
      msg = f?.text ?? '';
      // a refused save after the run (invalid settings, a failed probe) still reports what was done in Authentik
      if (f?.steps) result = { ok: false, steps: f.steps };
    } finally {
      token = ''; // used: a retry asks for it again
      busy = null;
    }
  }
</script>

<form novalidate on:submit|preventDefault={showPlan} aria-busy={busy === 'apply' ? 'true' : undefined}>
  <Field label={$t('setup.signin.akUrl')} hint={$t('setup.signin.akUrlHint')} let:id={fid} let:describedby>
    <input id={fid} type="text" inputmode="url" autocomplete="off" spellcheck="false" maxlength={2048} bind:value={url} aria-describedby={describedby}
      disabled={busy === 'apply'} on:input={urlChanged} />
  </Field>
  {#if isPlainHttp(url)}<Notice tone="warn"><p>{$t('setup.signin.insecure')}</p></Notice>{/if}
  <Field label={$t('setup.signin.akToken')} hint={$t('setup.signin.akTokenHint')} let:id={fid} let:describedby>
    <input id={fid} type="password" autocomplete="off" spellcheck="false" maxlength={512} bind:value={token} aria-describedby={describedby} disabled={busy === 'apply'} />
  </Field>
  <label class="check">
    <input type="checkbox" bind:checked={addMe} disabled={busy === 'apply'} aria-describedby="{id}-me" />
    <span>{$t('setup.signin.addMe')}</span>
  </label>
  <span class="hint" id="{id}-me">{$t('setup.signin.addMeHint')}</span>
  {#if !result?.ok}
    <div class="acts"><Button variant={plan && !planFailed ? 'secondary' : 'primary'} type="submit" icon="list" pending={busy === 'plan'} disabled={!ready || busy === 'apply'}>{$t('setup.signin.plan')}</Button></div>
  {/if}
</form>

{#if plan && !result}
  <section class="plan" aria-labelledby="{id}-p">
    <h3 id="{id}-p">{$t('setup.signin.planTitle')}</h3>
    <ul class="steps" aria-labelledby="{id}-p">
      {#each plan as s (s.id)}
        <li><span>{$t(`setup.ak.step.${s.id}`)}</span><StatusPill tone={TONE[s.state]} icon={ICON[s.state]} label={$t(`setup.ak.state.${s.state}`)} /></li>
      {/each}
    </ul>
    {#if planFailed}
      <Notice tone="err"><p>{akFailText(planFailed.detail)}</p></Notice>
    {:else}
      {#if plan.some((s) => s.id === 'provider' && s.state === 'update')}<p class="muted small">{$t('setup.signin.providerUpdate')}</p>{/if}
      <p class="muted small">{$t('setup.signin.planHint')}</p>
      {#if busy === 'apply'}
        <div class="progress" role="status"><span class="spinner" aria-hidden="true"></span><span>{$t('setup.signin.applying')}</span></div>
      {/if}
      {#if !token && busy !== 'apply'}<p class="muted small">{$t('setup.signin.tokenAgain')}</p>{/if}
      <div class="acts"><Button icon="check" pending={busy === 'apply'} disabled={!ready} on:click={apply}>{$t('setup.signin.apply')}</Button></div>
    {/if}
  </section>
{/if}

{#if result}
  <section class="plan" aria-labelledby="{id}-r">
    <h3 id="{id}-r">{$t('setup.signin.resultsTitle')}</h3>
    <ul class="steps" aria-labelledby="{id}-r">
      {#each result.steps as s (s.id)}
        <li><span>{$t(`setup.ak.step.${s.id}`)}</span><StatusPill tone={TONE[s.state]} icon={ICON[s.state]} label={$t(`setup.ak.state.${s.state}`)} /></li>
      {/each}
    </ul>
    {#if result.ok}
      <Notice tone="ok"><p>{$t('setup.signin.applied')}</p></Notice>
      {#if result.envKept?.length}<Notice tone="warn"><p>{$t('setup.signin.envKept', { keys: result.envKept.map(keyLabel).join(', ') })}</p></Notice>{/if}
      <h3 id="{id}-l">{$t('setup.signin.leftoversTitle')}</h3>
      <ul class="left" aria-labelledby="{id}-l">
        <li>{$t('setup.signin.leftovers.smtp')}</li>
        <li>{$t('setup.signin.leftovers.mfa')}</li>
        <li>{$t('setup.signin.leftovers.templates')}</li>
        {#if result.steps.some((s) => s.detail === 'template_missing')}<li>{$t('setup.signin.leftovers.emailChange')}</li>{/if}
      </ul>
      <div class="acts"><Button icon="chevron-right" on:click={() => dispatch('done')}>{$t('setup.next')}</Button></div>
    {:else}
      {#if applyFailed}<Notice tone="err"><p>{akFailText(applyFailed.detail)}</p><p>{$t('setup.signin.applyFailed')}</p></Notice>{/if}
      {#if busy === 'apply'}
        <div class="progress" role="status"><span class="spinner" aria-hidden="true"></span><span>{$t('setup.signin.applying')}</span></div>
      {/if}
      {#if !token}<p class="muted small">{$t('setup.signin.tokenAgain')}</p>{/if}
      <div class="acts"><Button icon="refresh" pending={busy === 'apply'} disabled={!ready} on:click={apply}>{$t('setup.signin.retry')}</Button></div>
    {/if}
  </section>
{/if}

{#if msg}<div class="msg"><Notice tone="err"><p>{msg}</p></Notice></div>{/if}

<style>
  form { display: grid; gap: .8rem; }
  .check { display: flex; align-items: center; gap: .6rem; min-height: 44px; cursor: pointer; }
  .check input { width: 20px; height: 20px; flex: none; }
  .hint { font-size: .82rem; color: var(--mut); margin-top: -.6rem; }
  .acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .6rem; }
  .plan { margin-top: 1.2rem; display: grid; gap: .7rem; }
  h3 { margin: .4rem 0 0; font-size: 1.05rem; }
  .steps { list-style: none; margin: 0; padding: 0; display: grid; }
  .steps li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .3rem .8rem; padding: .45rem 0; border-top: 1px solid var(--line); min-width: 0; }
  .steps li:first-child { border-top: 0; }
  .left { margin: 0; padding-left: 1.2rem; display: grid; gap: .4rem; }
  .small { font-size: .88rem; margin: 0; }
  .progress { display: flex; align-items: center; gap: .7rem; padding: .7rem .8rem; border-radius: 6px; background: var(--tone-info); }
  .msg { margin-top: .8rem; }
  @media (max-width: 480px) { .acts > :global(*) { flex: 1 1 100%; } }
</style>
