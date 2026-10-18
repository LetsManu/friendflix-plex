<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Status → Sign-in (Block 23 phase 3): which sign-in page is in use, whether the Authentik flows are there and of a kind
   * FriendFlix can show, the provider settings, passkeys, and the cover-wall switch. A warning never changes the mode.
   * The switch saves `LOGIN_COVER_WALL` through the settings (same store, audit and environment lock as Admin → Settings).
   */
  import { onMount } from 'svelte';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, t, trDynamic, type TKey } from '#lib/i18n';
  import { failClassText, loadLoginCheck, loginWarningText, repairAuthentik, type LoginCheck, type RepairResult } from './health';
  import { isReauthError } from '#lib/account/reauth';
  import ReauthDialog from '#lib/auth/ReauthDialog.svelte';
  import { loadSettings, saveSettings } from './settings/api';
  import { errorText } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import Toggle from '#lib/ui/Toggle.svelte';
  import { toast } from '#lib/ui/toast';

  let check: LoginCheck | null = null, failed = false;
  let wall: { on: boolean; locked: boolean } | null = null;
  let saving = false;
  /** the repair form: the one-time admin token (emptied once used), the run, its result and a re-auth before it */
  let repairToken = '', repairing = false, repair: RepairResult | null = null, repairErr = '', reauth = false;
  $: needsRepair = Boolean(check && check.warnings.some((w) => w === 'token:invalid' || w.startsWith('permission:') || w === 'optional:change-email'));
  const STEP_KEY = (id: string) => `setup.ak.step.${id}`;
  const failLine = (f: NonNullable<LoginCheck['lastFailures']>[number]) =>
    $t('adminContent.login.failLine', {
      area: $t(`adminContent.login.failArea.${f.area}` as TKey), cls: failClassText(f.cls), status: f.status ? ` (HTTP ${f.status})` : '',
      endpoint: f.endpoint, time: fmtDateTime(f.at),
    });

  const flowName = (kind: string) => (kind ? trDynamic(`adminContent.login.flows.${kind}`) : '');
  $: texts = check ? check.warnings.map((c) => loginWarningText(c, flowName)).filter(Boolean) : [];
  const TONE = { ok: 'ok', missing: 'err', unsupported: 'warn' } as const;
  const ICON = { ok: 'check', missing: 'alert', unsupported: 'clock' } as const;
  /** e-mail change is optional: a missing flow is shown as "optional", not as an error */
  const isOptional = (f: { kind: string; state: string }) => f.kind === 'change-email' && f.state === 'missing';

  async function runRepair(again = true) {
    const token = repairToken.trim();
    if (!token || repairing) return;
    repairing = true; repairErr = ''; repair = null;
    try {
      repair = await repairAuthentik(token);
      if (repair.check) check = repair.check;
      repairToken = '';
    } catch (e) {
      if (isReauthError(e) && again) { reauth = true; return; }
      repairToken = '';
      repairErr = errorText(e);
    } finally { repairing = false; }
  }
  async function recheck() {
    try { check = await loadLoginCheck(true); } catch (e) { toast.error(errorText(e)); }
  }

  async function load() {
    failed = false;
    try {
      check = await loadLoginCheck();
    } catch {
      failed = true;
    }
    try {
      const item = (await loadSettings()).groups.flatMap((g) => g.items).find((i) => i.key === 'LOGIN_COVER_WALL');
      wall = item ? { on: item.value === true, locked: item.source === 'env' } : null;
    } catch {
      wall = null;
    }
  }
  async function toggle(on: boolean) {
    saving = true;
    try {
      await saveSettings({ LOGIN_COVER_WALL: on });
      if (wall) wall = { ...wall, on };
      toast.success($t('adminContent.login.coverSaved'));
    } catch (e) {
      if (wall) wall = { ...wall }; // the switch flips back to what is saved
      toast.error(errorText(e));
    }
    saving = false;
  }
  onMount(load);
</script>

<section class="login" aria-labelledby="st-login">
  <div class="sh">
    <h2 id="st-login">{$t('adminContent.login.title')}</h2>
  </div>
  <p class="muted small intro">{$t('adminContent.login.intro')}</p>
  {#if failed && !check}
    <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('adminContent.login.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div>
  {:else if !check}
    <Skeleton w="100%" h="6rem" />
  {:else}
    <div class="box">
      <dl class="facts">
        <div><dt>{$t('adminContent.login.mode')}</dt><dd>{check.mode === 'app' ? $t('adminContent.login.modeApp') : $t('adminContent.login.modeAuthentik')}</dd></div>
        <div><dt>{$t('adminContent.login.passkeys')}</dt><dd>{check.passkeys === 'in-app' ? $t('adminContent.login.passkeysIn') : $t('adminContent.login.passkeysOut')}</dd></div>
      </dl>
      {#if check.flows.length}
        <ul class="flows">
          {#each check.flows as f (f.kind)}
            <li>
              <span class="fn">{flowName(f.kind)}</span>
              <code class="slug">{f.slug}</code>
              {#if isOptional(f)}
                <StatusPill tone="info" icon="info" label={$t('adminContent.login.states.optional')} />
              {:else}
                <StatusPill tone={TONE[f.state]} icon={ICON[f.state]} label={$t(`adminContent.login.states.${f.state}` as TKey)} />
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if check.serviceToken || check.executor}
        <dl class="facts">
          {#if check.serviceToken}<div><dt>{$t('adminContent.login.token')}</dt><dd data-check="token">{$t(`adminContent.login.tokenState.${check.serviceToken.token}` as TKey)}</dd></div>{/if}
          {#if check.executor}<div><dt>{$t('adminContent.login.executor')}</dt><dd data-check="executor">{check.executor.ok ? $t('adminContent.login.executorOk') : $t('adminContent.login.executorFail', { cls: failClassText(check.executor.cls), status: check.executor.status ? ` (HTTP ${check.executor.status})` : '', endpoint: check.executor.endpoint })}</dd></div>{/if}
        </dl>
      {/if}
      {#if check.lastFailures?.length}
        <div class="last">
          <h3 class="small">{$t('adminContent.login.lastFailures')}</h3>
          <ul>{#each check.lastFailures as f (f.area)}<li><code>{failLine(f)}</code></li>{/each}</ul>
        </div>
      {/if}
      {#if texts.length}
        <ul class="warns" role="list">{#each texts as w (w)}<li><Icon name="alert" size={16} /><span>{w}</span></li>{/each}</ul>
      {:else if check.flows.length}
        <p class="allok"><Icon name="check" size={16} /> {$t('adminContent.login.ok')}</p>
      {/if}
      <div class="acts"><Button variant="ghost" size="sm" icon="refresh" on:click={recheck}>{$t('adminContent.login.repair.recheck')}</Button></div>
    </div>
    {#if check.mode === 'app' || check.serviceToken}
      <form class="box repair" on:submit|preventDefault={() => runRepair()} aria-labelledby="st-repair" data-needed={needsRepair ? 'true' : undefined}>
        <h3 id="st-repair">{$t('adminContent.login.repair.title')}</h3>
        <p class="muted small">{$t('adminContent.login.repair.text')}</p>
        <label for="st-repair-token">{$t('adminContent.login.repair.tokenLabel')}</label>
        <input id="st-repair-token" type="password" autocomplete="off" spellcheck="false" maxlength="512" bind:value={repairToken} disabled={repairing} aria-describedby="st-repair-hint" />
        <p class="muted small" id="st-repair-hint">{$t('adminContent.login.repair.tokenHint')}</p>
        <div class="acts"><Button type="submit" icon="refresh" pending={repairing} disabled={!repairToken.trim()}>{$t('adminContent.login.repair.run')}</Button></div>
        {#if repairErr}<p class="rerr" role="alert">{repairErr}</p>{/if}
        {#if repair}
          <ul class="rsteps" aria-label={$t('adminContent.login.repair.title')}>
            {#each repair.steps as st (st.id)}
              <li><span>{trDynamic(STEP_KEY(st.id))}</span><span class="muted">{trDynamic(`setup.ak.state.${st.state}`)}{st.detail === 'template_missing' ? ` – ${$t('adminContent.login.repair.templateMissing')}` : ''}</span></li>
            {/each}
          </ul>
          <p role="status" class={repair.ok ? 'rok' : 'rerr'}>
            {repair.ok
              ? `${$t('adminContent.login.repair.done')}${repair.tokenSaved ? ` ${$t('adminContent.login.repair.tokenSaved')}` : ''}`
              : $t('adminContent.login.repair.failed', { detail: trDynamic(`setup.ak.fail.${repair.steps.find((x) => x.state === 'failed')?.detail ?? 'unexpected'}`) })}
          </p>
          {#if repair.envKept?.length}<p class="rerr">{$t('adminContent.login.repair.envKept')}</p>{/if}
        {/if}
      </form>
    {/if}
  {/if}
  {#if reauth}
    <ReauthDialog on:done={() => { reauth = false; void runRepair(false); }} on:close={() => { reauth = false; repairing = false; }} />
  {/if}
  {#if wall}
    <div class="box cover">
      <Toggle label={$t('adminContent.login.coverLabel')} hint={wall.locked ? $t('adminContent.login.coverLocked') : $t('adminContent.login.coverHelp')} checked={wall.on} disabled={wall.locked} pending={saving} on:change={(e) => toggle(e.detail)} />
    </div>
  {/if}
</section>

<style>
  section { margin-bottom: 1.4rem; }
  h2 { font-size: 1.05rem; font-weight: 700; margin: 0; }
  .sh { margin-bottom: .3rem; }
  .intro { margin: 0 0 .6rem; }
  .small { font-size: .85rem; }
  .box { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: .8rem .9rem; display: grid; gap: .8rem; margin-bottom: .6rem; min-width: 0; }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); gap: .5rem 1rem; margin: 0; }
  .facts div { min-width: 0; }
  dt { color: var(--mut); font-size: .8rem; }
  dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
  .flows { list-style: none; margin: 0; padding: 0; display: grid; gap: .4rem; }
  .flows li { display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .6rem; min-width: 0; }
  .fn { flex: 1 1 10rem; font-weight: 600; font-size: .92rem; }
  .slug { color: var(--mut); font-size: .78rem; overflow-wrap: anywhere; }
  .warns { list-style: none; margin: 0; padding: 0; display: grid; gap: .4rem; }
  .warns li { display: flex; gap: .5rem; align-items: flex-start; padding: .55rem .7rem; border-radius: 8px; background: var(--tone-warn); font-size: .88rem; overflow-wrap: anywhere; }
  .warns :global(svg) { flex: none; margin-top: .15rem; }
  .allok { margin: 0; display: flex; gap: .4rem; align-items: center; color: var(--ok); font-size: .9rem; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .7rem; text-align: center; padding: 1.4rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .repair { gap: .45rem; }
  .repair h3, .last h3 { margin: 0; font-size: .95rem; }
  .repair label { font-weight: 600; font-size: .9rem; }
  .repair input { min-height: 44px; padding: 0 .7rem; border-radius: 8px; border: 1px solid var(--line); background: var(--surface-2); color: var(--fg); font: inherit; min-width: 0; max-width: 28rem; }
  .repair p { margin: 0; }
  .rsteps, .last ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .25rem; font-size: .88rem; }
  .rsteps li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .2rem .8rem; }
  .last code { font-size: .8rem; overflow-wrap: anywhere; white-space: normal; }
  .rok { color: var(--ok); } .rerr { color: var(--err); }
  .acts { display: flex; gap: .5rem; flex-wrap: wrap; }
  .state p { margin: 0; } .state :global(svg) { color: var(--err); }
</style>
