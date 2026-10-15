<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Step 2: the public address (an origin), prefilled with the one the browser used. After the save the publicUrl probe runs: the
   * backend fetching itself through the address may fail inside the home network (NAT loopback), so its answer is a note, never a stop.
   */
  import { createEventDispatcher } from 'svelte';
  import { t } from '#lib/i18n';
  import { errorText as fieldText, keyHelp, keyLabel } from '#lib/admin/settings/form';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import type { ProbeResult } from '#lib/admin/settings/api';
  import { isPlainHttp, saveSetup, testSetup, type SetupState } from './api';
  import { probeText, type Handle, type Message } from './messages';
  import Notice from './Notice.svelte';

  export let state: SetupState;
  export let handle: Handle;
  /** the address typed on this visit (step 4 builds the redirect URI from it) */
  export let url = '';
  const dispatch = createEventDispatcher<{ done: void }>();
  let busy: 'save' | 'test' | null = null;
  let msg: Message | null = null;
  /** the probe's note after a save: shown with a Next button */
  let note = '';
  let ok = '';
  /** saved on this visit: the note's Next button may go on */
  let saved = false;

  $: fieldErr = msg?.fields?.PUBLIC_URL ? fieldText(msg.fields.PUBLIC_URL) : '';

  async function run(what: 'save' | 'test') {
    if (busy) return;
    busy = what;
    msg = null; note = ''; ok = '';
    try {
      if (what === 'save') {
        await saveSetup({ PUBLIC_URL: url.trim() });
        saved = true;
      }
      let r: ProbeResult;
      try {
        r = await testSetup('general', { PUBLIC_URL: url.trim() });
      } catch (e) {
        // saved: the check only adds a note, so it never keeps the person here
        if (what === 'save') { dispatch('done'); return; }
        throw e;
      }
      if (r.ok && r.code === 'ok') {
        if (what === 'save') dispatch('done');
        else ok = $t('setup.publicUrl.reachable');
      } else if (r.ok || what === 'save') note = probeText(r);
      else msg = { kind: 'message', text: probeText(r), probe: r };
    } catch (e) {
      msg = handle(e);
    } finally { busy = null; }
  }
</script>

<h2 id="setup-step-h">{$t('setup.publicUrl.title')}</h2>
<p>{$t('setup.publicUrl.text')}</p>
{#if state.steps.publicUrl === 'done'}<p class="muted">{$t('setup.doneText')}</p>{/if}
<form novalidate on:submit|preventDefault={() => run('save')}>
  <Field label={keyLabel('PUBLIC_URL')} hint={keyHelp('PUBLIC_URL')} error={fieldErr} let:id let:describedby let:invalid>
    <input {id} type="text" inputmode="url" autocomplete="off" spellcheck="false" maxlength={2048} bind:value={url} aria-describedby={describedby} aria-invalid={invalid}
      on:input={() => { msg = null; note = ''; ok = ''; saved = false; }} />
  </Field>
  {#if isPlainHttp(url)}<Notice tone="warn"><p>{$t('setup.publicUrl.http')}</p></Notice>{/if}
  {#if ok}<Notice tone="ok"><p>{ok}</p></Notice>{/if}
  {#if note}
    <Notice tone="warn">
      <p>{note}</p>
      {#if saved || state.steps.publicUrl !== 'todo'}<Button variant="secondary" size="sm" icon="chevron-right" on:click={() => dispatch('done')}>{$t('setup.next')}</Button>{/if}
    </Notice>
  {/if}
  {#if msg && !fieldErr}<Notice tone="err"><p>{msg.text}</p></Notice>{/if}
  <div class="acts">
    <Button variant="secondary" icon="activity" pending={busy === 'test'} disabled={!url.trim()} on:click={() => run('test')}>{$t('setup.test')}</Button>
    <Button type="submit" icon="check" pending={busy === 'save'} disabled={!url.trim()}>{$t('setup.saveNext')}</Button>
  </div>
</form>

<style>
  form { display: grid; gap: .8rem; }
  .acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .6rem; }
  @media (max-width: 480px) { .acts > :global(*) { flex: 1 1 100%; } }
</style>
