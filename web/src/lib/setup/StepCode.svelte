<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Step 1: the one-time setup code from the backend's log opens the setup session. The code lives only in the input and the request:
   * the field is emptied after every attempt, and it is never stored.
   */
  import { createEventDispatcher } from 'svelte';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';
  import { uid } from '#lib/ui/ids';
  import { unlock } from './api';
  import { failure } from './messages';

  /** the setup session ran out: say why the code is asked again */
  export let expired = false;
  const dispatch = createEventDispatcher<{ unlocked: void; complete: void }>();
  const id = uid('code');
  let code = '', busy = false, msg = '';

  async function submit() {
    if (!code.trim() || busy) return;
    busy = true;
    msg = '';
    try {
      await unlock(code);
      expired = false;
      dispatch('unlocked');
    } catch (e) {
      const f = failure(e);
      if (f.kind === 'complete') dispatch('complete');
      msg = f.kind === 'message' ? f.text : '';
    } finally {
      code = ''; // never kept, not even for a retry
      busy = false;
    }
  }
</script>

<h2 id="setup-step-h">{$t('setup.code.title')}</h2>
{#if expired}<p class="note" role="status">{$t('setup.expired')}</p>{/if}
<p>{$t('setup.code.text')}</p>
<pre class="cmd"><code>{$t('setup.code.command')}</code></pre>
<form novalidate on:submit|preventDefault={submit}>
  <div class="field">
    <label for={id}>{$t('setup.code.label')}</label>
    <input {id} bind:value={code} type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength={64}
      inputmode="text" aria-describedby="{id}-h{msg ? ` ${id}-e` : ''}" aria-invalid={msg ? 'true' : undefined} />
    <span class="hint" id="{id}-h">{$t('setup.code.hint')}</span>
  </div>
  {#if msg}<p class="err" id="{id}-e" role="alert">{msg}</p>{/if}
  <div class="acts"><Button type="submit" icon="unlock" pending={busy} disabled={!code.trim()}>{$t('setup.code.submit')}</Button></div>
</form>

<style>
  form { display: grid; gap: .8rem; }
  .field { display: flex; flex-direction: column; gap: .3rem; }
  input { width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; }
  .hint { font-size: .82rem; color: var(--mut); }
  .cmd { margin: 0 0 1rem; padding: .6rem .8rem; border-radius: 6px; background: var(--surface); border: 1px solid var(--line); overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .85rem; }
  .note { padding: .6rem .8rem; border-radius: 6px; background: var(--tone-warn); }
  .err { margin: 0; color: var(--err); font-weight: 600; }
  .acts { display: flex; flex-wrap: wrap; gap: .6rem; }
  @media (max-width: 480px) { .acts > :global(*) { flex: 1 1 100%; } }
</style>
