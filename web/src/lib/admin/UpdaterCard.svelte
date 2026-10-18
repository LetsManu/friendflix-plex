<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Update with the opt-in updater (lib/admin/updater.ts): installed / previous tag, "Update now", "Back to previous
   * version", "Update the updater" (inline confirmation, no dialog), the job's steps with live status, the result of the last
   * job and the automatic updates. A job restarts the backend: failed polls show "reconnecting" and the page picks the result up
   * when it answers again (also after a reload: the updater keeps the last job). A start that needs a recent sign-in goes through
   * /auth/reauth and comes back with ?reauth=1 (the person starts the job again; nothing restarts on its own).
   */
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { api } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, t, tr } from '#lib/i18n';
  import { isReauthError, startReauth } from '#lib/account/reauth';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { saveSettings } from '#lib/admin/settings/api';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import Progress from '#lib/ui/Progress.svelte';
  import Select from '#lib/ui/Select.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import { toast } from '#lib/ui/toast';
  import {
    TIME_RE, WATCH_MAX_MS, canRollback, failReason, isRunning, nextPoll, startError, statusOf, visibleSteps,
    type StepState, type UpdaterAction, type UpdaterJob, type UpdaterView,
  } from './updater';

  export let view: UpdaterView;
  /** shown once after coming back from the sign-in */
  export let reauthBack = false;
  const dispatch = createEventDispatcher<{ finished: void }>();

  $: s = statusOf(view);
  $: job = s?.job ?? null;
  $: running = isRunning(job);
  let confirming: UpdaterAction | null = null;
  let reconnecting = false, watchTimeout = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let t0 = 0, now = Date.now();
  let watchedId: string | null = null;

  async function refresh(): Promise<boolean> {
    try { view = await api<UpdaterView>('/api/admin/updater'); return true; } catch { return false; }
  }
  function stopWatch() { clearTimeout(timer); timer = undefined; }
  /** polls while the job runs; a failed poll (the backend restarts) is "reconnecting", never an error */
  function watch() {
    stopWatch();
    watchTimeout = false;
    if (!t0) t0 = Date.now();
    const tick = async () => {
      now = Date.now();
      const ok = await refresh();
      reconnecting = !ok;
      const j = statusOf(view)?.job;
      if (ok && !isRunning(j)) { t0 = 0; stopWatch(); if (watchedId && j?.id === watchedId) dispatch('finished'); watchedId = null; return; }
      if (Date.now() - t0 > WATCH_MAX_MS) { stopWatch(); watchTimeout = true; t0 = 0; return; }
      timer = setTimeout(tick, nextPoll(reconnecting));
    };
    timer = setTimeout(tick, nextPoll(false));
  }
  onMount(() => { if (running) { watchedId = job?.id ?? null; watch(); } });
  onDestroy(stopWatch);
  const clock = setInterval(() => { if (t0) now = Date.now(); }, 1000);
  onDestroy(() => clearInterval(clock));

  async function start(action: UpdaterAction) {
    confirming = null;
    const res = await runAction({ key: `updater:${action}`, run: () => api<{ job: UpdaterJob }>(`/api/admin/updater/${action}`, { method: 'POST' }), error: false });
    if (res.ok && res.value) {
      watchedId = res.value.job.id;
      if (s) view = { ...view, present: true, status: { ...s, busy: true, job: res.value.job } } as UpdaterView;
      t0 = Date.now();
      watch();
      return;
    }
    if (isReauthError(res.error)) { startReauth('/admin/update?reauth=1'); return; }
    toast.error(startError(res.error));
  }

  const confirmTag = (a: UpdaterAction) => (a === 'rollback' ? s?.previous : s?.targetTag) ?? '';
  const stepTone = (st: StepState) => (st === 'ok' ? 'ok' : st === 'failed' ? 'err' : st === 'running' ? 'warn' : 'muted');
  $: elapsed = t0 ? Math.max(0, Math.round((now - t0) / 1000)) : 0;
  $: resultText = job && !running
    ? job.state === 'succeeded' ? tr('admin.update.updater.result.succeeded', { to: job.to })
      : job.state === 'rolled_back' ? tr('admin.update.updater.result.rolled_back', { from: job.from ?? tr('admin.update.updater.none') })
        : tr('admin.update.updater.result.failed', { reason: failReason(job.error) })
    : '';

  // automatic updates (settings AUTO_UPDATE / AUTO_UPDATE_TIME)
  let autoMode = view.autoUpdate?.mode ?? 'off', autoTime = view.autoUpdate?.time ?? '04:00', autoErr = '';
  $: autoLocked = (view.autoUpdate?.locked ?? []).length > 0;
  $: autoOptions = [{ value: 'off', label: $t('admin.update.updater.auto.off') }, { value: 'nightly-window', label: $t('admin.update.updater.auto.window') }];
  async function saveAuto() {
    autoErr = '';
    if (autoMode === 'nightly-window' && !TIME_RE.test(autoTime)) { autoErr = tr('admin.update.updater.auto.timeInvalid'); return; }
    const r = await runAction({ key: 'updater:auto', run: () => saveSettings({ AUTO_UPDATE: autoMode, AUTO_UPDATE_TIME: autoTime }), success: tr('admin.update.updater.auto.saved'), error: (e) => errorText(e) });
    if (r.ok) await refresh();
  }
</script>

<AdminCard title={$t('admin.update.updater.title')}>
  <p class="muted intro">{$t('admin.update.updater.intro')}</p>
  {#if reauthBack}<p class="banner" role="status"><Icon name="check" size={18} />{$t('admin.update.updater.reauthBack')}</p>{/if}

  {#if view.present && 'error' in view}
    <p class="banner warn" role="alert"><Icon name="alert" size={18} />{view.error === 'unauthorized' ? $t('admin.update.updater.unauthorized') : $t('admin.update.updater.invalid')}</p>
  {:else if s}
    <dl class="ver" data-updater>
      <div><dt>{$t('admin.update.updater.installed')}</dt><dd><code>{s.current ?? $t('admin.update.updater.none')}</code></dd></div>
      <div><dt>{$t('admin.update.updater.previous')}</dt><dd><code>{s.previous ?? $t('admin.update.updater.none')}</code></dd></div>
      <div><dt>{$t('admin.update.updater.target')}</dt><dd><code>{s.targetTag ?? $t('admin.update.updater.none')}</code></dd></div>
    </dl>

    {#if confirming}
      <div class="confirm" role="group" aria-label={$t(`admin.update.updater.confirm.${confirming}` as 'admin.update.updater.confirm.update', { tag: confirmTag(confirming) })}>
        <p>{$t(`admin.update.updater.confirm.${confirming}` as 'admin.update.updater.confirm.update', { tag: confirmTag(confirming) })}</p>
        <div class="row">
          <Button variant={confirming === 'self-update' ? 'primary' : 'danger'} icon="check" on:click={() => confirming && start(confirming)}>{$t('admin.update.updater.confirmGo')}</Button>
          <Button variant="secondary" on:click={() => (confirming = null)}>{$t('admin.update.updater.cancel')}</Button>
        </div>
      </div>
    {:else}
      <div class="row actions">
        <Button icon="download" pending={$busyKeys.has('updater:update')} disabled={running || s.busy || !s.targetTag} on:click={() => (confirming = 'update')}>{$t('admin.update.updater.updateNow')}</Button>
        <Button variant="secondary" icon="arrow-left" pending={$busyKeys.has('updater:rollback')} disabled={!canRollback(s)} on:click={() => (confirming = 'rollback')}>{$t('admin.update.updater.rollback')}</Button>
      </div>
    {/if}

    {#if job}
      <div class="prog" aria-live="polite">
        {#if running}
          <Progress value={null} label={$t('admin.update.updater.running', { s: elapsed })} />
          {#if reconnecting}<p class="muted small" role="status" data-reconnecting><Icon name="refresh" size={16} /> {$t('admin.update.updater.reconnecting')}</p>{/if}
        {:else}
          <p class="small"><span class="muted">{$t('admin.update.updater.lastJob')}</span> <time datetime={job.finishedAt ?? job.startedAt}>{fmtDateTime(job.finishedAt ?? job.startedAt)}</time></p>
          <p class="result" class:ok={job.state === 'succeeded'} class:bad={job.state !== 'succeeded'} role={job.state === 'succeeded' ? 'status' : 'alert'} data-result={job.state}>
            <Icon name={job.state === 'succeeded' ? 'check' : 'alert'} size={18} /> {resultText}
          </p>
        {/if}
        {#if watchTimeout}<p class="err small" role="alert">{$t('admin.update.updater.watchTimeout')}</p>{/if}
        <ol class="steps">
          {#each visibleSteps(job) as st (st)}
            <li data-step={st} data-state={job.steps[st]} aria-current={job.step === st && running ? 'step' : undefined}>
              <span class="name">{$t(`admin.update.updater.step.${st}` as 'admin.update.updater.step.pull')}</span>
              <StatusPill tone={stepTone(job.steps[st])} label={$t(`admin.update.updater.state.${job.steps[st]}` as 'admin.update.updater.state.ok')} />
            </li>
          {/each}
        </ol>
      </div>
    {/if}

    {#if s.log.length}
      <details class="log"><summary>{$t('admin.update.updater.log')}</summary><pre>{s.log.join('\n')}</pre></details>
    {/if}

    <div class="auto">
      <h3>{$t('admin.update.updater.auto.title')}</h3>
      <p class="muted small">{$t('admin.update.updater.auto.hint')}</p>
      <div class="row">
        <Select label={$t('admin.update.updater.auto.label')} bind:value={autoMode} options={autoOptions} disabled={autoLocked} />
        {#if autoMode === 'nightly-window'}<Field label={$t('admin.update.updater.auto.time')} type="time" bind:value={autoTime} disabled={autoLocked} error={autoErr} width="8rem" />{/if}
        <Button variant="secondary" pending={$busyKeys.has('updater:auto')} disabled={autoLocked} on:click={saveAuto}>{$t('admin.update.updater.auto.save')}</Button>
      </div>
      {#if autoLocked}<p class="muted small" role="note">{$t('admin.update.updater.auto.locked')}</p>{/if}
    </div>

    <details class="self">
      <summary>{$t('admin.update.updater.advanced')}</summary>
      <p class="muted small">{$t('admin.update.updater.selfHint', { version: s.updater.version ?? $t('admin.update.updater.none') })}</p>
      <Button variant="secondary" icon="refresh" pending={$busyKeys.has('updater:self-update')} disabled={running || s.busy || confirming !== null} on:click={() => (confirming = 'self-update')}>{$t('admin.update.updater.selfUpdate')}</Button>
    </details>
  {/if}
</AdminCard>

<style>
  .intro { margin: 0 0 1rem; max-width: 70ch; }
  .ver { margin: 0 0 1rem; display: grid; gap: .5rem; }
  .ver > div { display: grid; grid-template-columns: minmax(7rem, 11rem) minmax(0, 1fr); gap: .6rem; align-items: center; }
  dt { color: var(--mut); font-size: .9rem; } dd { margin: 0; overflow-wrap: anywhere; min-width: 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(255,255,255,.07); padding: .05rem .4rem; border-radius: 4px; }
  .row { display: flex; flex-wrap: wrap; gap: .8rem; align-items: flex-end; min-width: 0; }
  .confirm { border: 1px solid var(--warn); border-radius: 8px; padding: .8rem 1rem; display: grid; gap: .6rem; max-width: 40rem; }
  .confirm p { margin: 0; overflow-wrap: anywhere; }
  .prog { margin-top: 1.2rem; display: grid; gap: .8rem; max-width: 36rem; min-width: 0; }
  .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: .5rem; }
  .steps li { display: flex; align-items: center; justify-content: space-between; gap: .7rem; flex-wrap: wrap; min-width: 0; }
  .steps li[aria-current='step'] .name { font-weight: 600; }
  .result { display: flex; gap: .5rem; align-items: flex-start; margin: 0; overflow-wrap: anywhere; }
  .result.ok :global(svg) { color: var(--ok); } .result.bad :global(svg) { color: var(--err); }
  .small { font-size: .88rem; margin: 0; }
  .err { color: var(--err); }
  .log { margin-top: 1rem; } .log summary, .self summary { cursor: pointer; font-weight: 600; min-height: 44px; display: flex; align-items: center; }
  .log pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .8rem; max-height: 16rem; overflow: auto; margin: 0; }
  .auto { margin-top: 1.2rem; border-top: 1px solid var(--line); padding-top: .9rem; display: grid; gap: .6rem; }
  .auto h3 { margin: 0; font-size: 1rem; }
  .self { margin-top: 1rem; border-top: 1px solid var(--line); padding-top: .4rem; display: grid; gap: .6rem; }
  .banner { display: flex; gap: .5rem; align-items: flex-start; margin: 0 0 1rem; padding: .6rem .8rem; border-radius: 8px; background: rgba(255,255,255,.05); overflow-wrap: anywhere; }
  .banner.warn { border: 1px solid var(--warn); }
  @media (max-width: 560px) { .ver > div { grid-template-columns: minmax(0, 1fr); gap: .2rem; } }
</style>
