<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The setup wizard (spec Part F), steps 1-5; step 6 is /setup/extras, signed in. A public page (no /api/me): the layout sends a new
   * install here when /api/me answers 503 setup_required. GET /api/setup/state decides where to start: the code step until this
   * browser holds a setup session, then the first step that still needs something. A step whose keys come from the environment is
   * shown locked with a Next button and skipped on the way in. An expired setup session (also ?expired=1 from the sign-in) goes back to the code step; a completed setup
   * (someone else finished) goes to / with a full page load (the layout has not loaded the account on this public page).
   */
  import { onMount, tick } from 'svelte';
  import { publicLocale, setLocale, t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import Logo from '#lib/Logo.svelte';
  import Button from '#lib/ui/Button.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import { firstOpenStep, setupState, type SetupState, type StepState } from '#lib/setup/api';
  import { failure, type Message } from '#lib/setup/messages';
  import Notice from '#lib/setup/Notice.svelte';
  import StepAdmin from '#lib/setup/StepAdmin.svelte';
  import StepCode from '#lib/setup/StepCode.svelte';
  import StepMedia from '#lib/setup/StepMedia.svelte';
  import StepPublicUrl from '#lib/setup/StepPublicUrl.svelte';
  import StepSignin from '#lib/setup/StepSignin.svelte';

  type N = 1 | 2 | 3 | 4 | 5;
  const STEPS = [[1, 'code'], [2, 'publicUrl'], [3, 'media'], [4, 'signin'], [5, 'admin']] as const;
  const KEY = { 2: 'publicUrl', 3: 'media', 4: 'signin' } as const;

  let s: SetupState | null = null;
  let loadFailed = false, loading = false;
  let step: N = 1;
  let expired = false;
  /** the public address typed on this visit; until then the backend's (the saved one, else the origin this browser used) */
  let publicUrl = '';
  let stepEl: HTMLElement;

  const leave = () => { location.href = '/'; };

  function stateOf(n: N): StepState {
    if (!s) return 'todo';
    if (n === 1) return s.unlocked ? 'done' : 'todo';
    return n === 5 ? s.steps.admin : s.steps[KEY[n]];
  }
  /** the step after `n` that still needs something (locked and finished ones are passed) */
  function nextOpen(n: N): N {
    for (let k = n + 1; k <= 4; k++) if (stateOf(k as N) === 'todo') return k as N;
    return 5;
  }

  async function go(n: N, focus = true) {
    step = n;
    if (!focus) return;
    await tick();
    stepEl?.focus();
  }

  /** `start`: where a fresh state begins; `after`: the step just finished (go to the next open one); `stay`: keep the step */
  async function refresh(how: { start: true } | { after: N } | { stay: true }) {
    loading = true;
    loadFailed = false;
    let r: Awaited<ReturnType<typeof setupState>>;
    try {
      r = await setupState();
    } catch {
      loadFailed = true;
      return;
    } finally { loading = false; }
    if (r.complete) return leave();
    s = r;
    if (!publicUrl) publicUrl = s.prefill.publicUrl ?? '';
    if (!s.unlocked) return go(1, !('start' in how));
    if ('start' in how) return go(firstOpenStep(s), false);
    if ('after' in how) return go(nextOpen(how.after));
  }

  /** a refused call: the session or the whole setup is gone (handled here), else the step shows the message */
  function handle(e: unknown): Message | null {
    const f = failure(e);
    if (f.kind === 'complete') { leave(); return null; }
    if (f.kind === 'session') {
      expired = true;
      if (s) s = { ...s, unlocked: false };
      void go(1);
      return null;
    }
    return f;
  }

  onMount(() => {
    // the backend sends a sign-in whose setup session ran out back here (/setup?expired=1): the code step says why
    if (new URLSearchParams(location.search).get('expired') === '1') expired = true;
    const pre = publicLocale();
    if (pre) void setLocale(pre);
    void refresh({ start: true });
  });
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('setup.pageTitle') })}</title></svelte:head>
<div class="setup">
  <div class="logo"><Logo wordmark size={40} /></div>
  <main class="card" id="main">
    <h1>{$t('setup.title')}</h1>
    <p class="muted intro">{$t('setup.intro')}</p>
    {#if loadFailed}
      <Notice tone="err">
        <p>{$t('setup.loadFailed')}</p>
        <Button variant="secondary" size="sm" icon="refresh" on:click={() => refresh({ start: true })}>{$t('setup.retry')}</Button>
      </Notice>
    {:else if !s}
      <p class="muted" role="status">{$t('setup.loading')}</p>
    {:else}
      <nav aria-label={$t('setup.stepsLabel')}>
        <ol class="steps">
          {#each STEPS as [n, k] (n)}
            {@const st = stateOf(n)}
            <li>
              <button type="button" class="stp" class:cur={step === n} class:done={st !== 'todo'} aria-current={step === n ? 'step' : undefined}
                disabled={n > 1 && !s.unlocked} aria-label={$t('setup.stepA11y', { n, name: $t(`setup.steps.${k}`), state: $t(`setup.stepState.${st}`) })}
                on:click={() => go(n)}>
                <span class="num" aria-hidden="true">{#if st !== 'todo' && step !== n}<Icon name={st === 'env' ? 'lock' : 'check'} size={16} />{:else}{n}{/if}</span>
                <span class="name" aria-hidden="true">{$t(`setup.steps.${k}`)}</span>
              </button>
            </li>
          {/each}
          <li class="later">
            <span class="num" aria-hidden="true">6</span><span class="name" aria-hidden="true">{$t('setup.steps.extras')}</span>
            <span class="sr-only">{$t('setup.stepA11y', { n: 6, name: $t('setup.steps.extras'), state: $t('setup.stepState.todo') })}</span>
          </li>
        </ol>
      </nav>

      <section class="step" aria-labelledby="setup-step-h" tabindex="-1" bind:this={stepEl} aria-busy={loading ? 'true' : undefined}>
        {#if step === 1}
          <StepCode {expired} on:unlocked={() => { expired = false; void refresh({ after: 1 }); }} on:complete={leave} />
        {:else if step !== 5 && stateOf(step) === 'env'}
          <h2 id="setup-step-h">{$t(`setup.steps.${KEY[step as 2 | 3 | 4]}`)}</h2>
          <p><StatusPill tone="info" icon="lock" label={$t('setup.fromEnv')} /></p>
          <p>{$t('setup.fromEnvText')}</p>
          <div class="acts"><Button icon="chevron-right" on:click={() => go((step + 1) as N)}>{$t('setup.next')}</Button></div>
        {:else if step === 2}
          <StepPublicUrl state={s} {handle} bind:url={publicUrl} on:done={() => refresh({ after: 2 })} />
        {:else if step === 3}
          <StepMedia state={s} {handle} on:done={() => refresh({ after: 3 })} />
        {:else if step === 4}
          <StepSignin state={s} {handle} {publicUrl} on:done={() => refresh({ after: 4 })} />
        {:else}
          <StepAdmin state={s} viaAuthentik={s.signinVia === 'authentik'} on:go={(e) => go(e.detail)} />
        {/if}
      </section>
    {/if}
  </main>
</div>

<style>
  .setup { min-height: 100vh; display: flex; flex-direction: column; align-items: center; gap: 1.2rem; padding: calc(1.5rem + var(--safe-top)) max(1rem, var(--safe-right)) calc(2rem + var(--safe-bottom)) max(1rem, var(--safe-left)); background: linear-gradient(rgba(0,0,0,.65), rgba(0,0,0,.9)), radial-gradient(circle at 20% 10%, #5a0b14, #000 60%); }
  .logo { align-self: flex-start; display: inline-flex; }
  .card { background: rgba(0,0,0,.78); padding: 2rem clamp(1rem, 5vw, 2.6rem); border-radius: 8px; width: min(100%, 680px); min-width: 0; }
  h1 { font-size: 1.8rem; margin: 0 0 .4rem; }
  .intro { margin: 0 0 1.4rem; }
  .steps { list-style: none; margin: 0 0 1.4rem; padding: 0; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: .3rem; }
  .steps li { min-width: 0; }
  .stp, .later { width: 100%; min-height: 44px; display: flex; flex-direction: column; align-items: center; gap: .25rem; padding: .35rem .2rem; border-radius: 6px; background: transparent; border: 0; color: var(--mut); font-size: .75rem; text-align: center; }
  .stp:not(:disabled):hover { background: rgba(255,255,255,.08); }
  .stp:disabled { opacity: .55; }
  .num { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; border: 2px solid currentColor; font-weight: 700; font-size: .85rem; }
  .done { color: var(--ok); }
  .cur { color: var(--fg); }
  .cur .num { background: var(--acc); border-color: var(--acc); color: #fff; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .step { display: grid; gap: .2rem; outline: none; }
  .step :global(h2) { font-size: 1.35rem; margin: 0 0 .5rem; }
  .step :global(p) { margin: 0 0 .8rem; }
  .acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .6rem; }
  @media (max-width: 560px) { .name { display: none; } }
  @media (max-width: 480px) { .acts > :global(*) { flex: 1 1 100%; } }
</style>
