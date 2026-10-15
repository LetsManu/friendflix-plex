<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Step 3: the media server, rendered from GET /api/setup/state (spec Part H): `media.keys` are the manual fields (labels
   * settings.keys.<KEY>, the key itself without a text), `media.auto` the fields of "Create API key automatically" (null = manual only).
   * The administrator's password is sent once and the field is emptied afterwards; a typed API key is emptied after the save.
   */
  import { createEventDispatcher } from 'svelte';
  import { t } from '#lib/i18n';
  import { errorText as fieldText, keyHelp, keyLabel } from '#lib/admin/settings/form';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import { mediaAuto, saveSetup, testSetup, type AutoField, type SetupState } from './api';
  import { filled, isSecretKey, otherFieldErrors, probeText, type Handle, type Message } from './messages';
  import Notice from './Notice.svelte';

  export let state: SetupState;
  export let handle: Handle;
  const dispatch = createEventDispatcher<{ done: void }>();

  $: autoFields = state.media.auto ?? [];
  let mode: 'auto' | 'manual' = state.media.auto?.length ? 'auto' : 'manual';
  let auto: Record<AutoField, string> = { url: '', username: '', password: '' };
  let manual: Record<string, string> = Object.fromEntries(state.media.keys.map((k) => [k, '']));
  let busy: 'auto' | 'save' | 'test' | 'force' | null = null;
  let msg: Message | null = null;
  let ok = '';

  const AUTO_LABEL = { url: 'setup.media.url', username: 'setup.media.username', password: 'setup.media.password' } as const;
  $: autoReady = autoFields.every((f) => auto[f].trim() || f === 'password');
  $: manualValues = filled(manual);
  $: others = otherFieldErrors(msg?.fields, mode === 'manual' ? state.media.keys : []);
  $: fieldErr = (key: string) => (msg?.fields?.[key] ? fieldText(msg.fields[key]!) : '');

  function setMode(m: 'auto' | 'manual') { mode = m; msg = null; ok = ''; }

  async function createKey() {
    if (busy) return;
    busy = 'auto'; msg = null; ok = '';
    try {
      const r = await mediaAuto({ url: auto.url.trim(), username: auto.username.trim(), password: auto.password });
      if (r.ok) { ok = $t('setup.media.created'); dispatch('done'); }
      else msg = { kind: 'message', text: probeText(r), probe: r };
    } catch (e) {
      msg = handle(e);
    } finally {
      auto.password = ''; // used once
      busy = null;
    }
  }

  async function test() {
    if (busy) return;
    busy = 'test'; msg = null; ok = '';
    try {
      const r = await testSetup('media', manualValues);
      if (r.ok) ok = probeText(r);
      else msg = { kind: 'message', text: probeText(r), probe: r };
    } catch (e) { msg = handle(e); } finally { busy = null; }
  }

  async function save(force = false) {
    if (busy) return;
    busy = force ? 'force' : 'save'; msg = null; ok = '';
    try {
      await saveSetup(manualValues, force);
      // the key is saved: it never stays in the page
      manual = Object.fromEntries(Object.entries(manual).map(([k, v]) => [k, isSecretKey(k) ? '' : v]));
      dispatch('done');
    } catch (e) { msg = handle(e); } finally { busy = null; }
  }
</script>

<h2 id="setup-step-h">{$t('setup.media.title')}</h2>
<p>{$t('setup.media.text')}</p>
{#if state.steps.media === 'done'}<p class="muted">{$t('setup.doneText')}</p>{/if}

{#if autoFields.length}
  <div class="seg" role="group" aria-label={$t('setup.media.modeLabel')}>
    <button type="button" class:on={mode === 'auto'} aria-pressed={mode === 'auto'} on:click={() => setMode('auto')}>{$t('setup.media.auto')}</button>
    <button type="button" class:on={mode === 'manual'} aria-pressed={mode === 'manual'} on:click={() => setMode('manual')}>{$t('setup.media.manual')}</button>
  </div>
{:else}
  <p class="muted">{$t('setup.media.noAuto')}</p>
{/if}

{#if mode === 'auto'}
  <form novalidate on:submit|preventDefault={createKey}>
    <p>{$t('setup.media.autoText')}</p>
    {#each autoFields as f (f)}
      <Field label={$t(AUTO_LABEL[f])} hint={f === 'url' ? $t('setup.media.urlHint') : ''} let:id let:describedby>
        {#if f === 'password'}
          <input {id} type="password" autocomplete="off" maxlength={1024} bind:value={auto.password} aria-describedby={describedby} />
        {:else if f === 'url'}
          <input {id} type="text" inputmode="url" autocomplete="off" spellcheck="false" maxlength={2048} bind:value={auto.url} aria-describedby={describedby} />
        {:else}
          <input {id} type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength={256} bind:value={auto.username} aria-describedby={describedby} />
        {/if}
      </Field>
    {/each}
    {#if ok}<Notice tone="ok"><p>{ok}</p></Notice>{/if}
    {#if msg}<Notice tone="err"><p>{msg.text}</p>{#each others as o (o)}<p>{o}</p>{/each}</Notice>{/if}
    <div class="acts"><Button type="submit" icon="key" pending={busy === 'auto'} disabled={!autoReady}>{$t('setup.media.create')}</Button></div>
  </form>
{:else}
  <form novalidate on:submit|preventDefault={() => save()}>
    <p>{$t('setup.media.manualText')}</p>
    {#each state.media.keys as key (key)}
      <Field label={keyLabel(key)} hint={keyHelp(key)} error={fieldErr(key)} let:id let:describedby let:invalid>
        <input {id} type={isSecretKey(key) ? 'password' : 'text'} autocomplete="off" spellcheck="false" maxlength={4096} bind:value={manual[key]}
          aria-describedby={describedby} aria-invalid={invalid} />
      </Field>
    {/each}
    {#if ok}<Notice tone="ok"><p>{ok}</p></Notice>{/if}
    {#if msg && (!msg.fields || others.length)}
      <Notice tone="err">
        <p>{msg.text}</p>
        {#each others as o (o)}<p>{o}</p>{/each}
        {#if msg.soft}
          <p>{$t('setup.saveSoft')}</p>
          <Button variant="secondary" size="sm" pending={busy === 'force'} on:click={() => save(true)}>{$t('setup.saveAnyway')}</Button>
        {/if}
      </Notice>
    {/if}
    <div class="acts">
      <Button variant="secondary" icon="activity" pending={busy === 'test'} disabled={!Object.keys(manualValues).length} on:click={test}>{$t('setup.test')}</Button>
      <Button type="submit" icon="check" pending={busy === 'save'} disabled={!Object.keys(manualValues).length}>{$t('setup.saveNext')}</Button>
    </div>
  </form>
{/if}

<style>
  form { display: grid; gap: .8rem; }
  form > p { margin: 0; }
  .acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .6rem; }
  .seg { display: inline-flex; gap: .25rem; padding: .25rem; margin-bottom: 1rem; border-radius: 8px; background: var(--surface); border: 1px solid var(--line); max-width: 100%; }
  .seg button { min-height: 44px; padding: .4rem 1rem; border-radius: 6px; background: transparent; color: var(--fg); border: 0; font-weight: 600; }
  .seg button.on { background: var(--fg); color: var(--bg); }
  @media (max-width: 480px) { .acts > :global(*) { flex: 1 1 100%; } .seg { display: flex; } .seg button { flex: 1; } }
</style>
