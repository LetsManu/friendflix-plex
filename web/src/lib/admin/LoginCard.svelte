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
  import { t, trDynamic, type TKey } from '#lib/i18n';
  import { loadLoginCheck, loginWarningText, type LoginCheck } from './health';
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

  const flowName = (kind: string) => (kind ? trDynamic(`adminContent.login.flows.${kind}`) : '');
  $: texts = check ? check.warnings.map((c) => loginWarningText(c, flowName)).filter(Boolean) : [];
  const TONE = { ok: 'ok', missing: 'err', unsupported: 'warn' } as const;
  const ICON = { ok: 'check', missing: 'alert', unsupported: 'clock' } as const;

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
              <StatusPill tone={TONE[f.state]} icon={ICON[f.state]} label={$t(`adminContent.login.states.${f.state}` as TKey)} />
            </li>
          {/each}
        </ul>
      {/if}
      {#if texts.length}
        <ul class="warns" role="list">{#each texts as w (w)}<li><Icon name="alert" size={16} /><span>{w}</span></li>{/each}</ul>
      {:else if check.flows.length}
        <p class="allok"><Icon name="check" size={16} /> {$t('adminContent.login.ok')}</p>
      {/if}
    </div>
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
  .state p { margin: 0; } .state :global(svg) { color: var(--err); }
</style>
