<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Step 4: the sign-in. Automatic: the Authentik automation (AkSteps). By hand: the OIDC client of the provider (issuer, client ID and
   * secret, admin group) plus the optional Authentik API for invitations, with the oidc and authentik probes and a checklist of what the
   * provider needs (strict redirect URI, implicit consent, grant type authorization_code). Typed secrets are emptied after the save.
   */
  import { createEventDispatcher } from 'svelte';
  import { t } from '#lib/i18n';
  import { errorText as fieldText, keyHelp, keyLabel } from '#lib/admin/settings/form';
  import Button from '#lib/ui/Button.svelte';
  import CopyField from '#lib/ui/CopyField.svelte';
  import Field from '#lib/ui/Field.svelte';
  import { isPlainHttp, redirectUri, saveSetup, testSetup, type SetupState } from './api';
  import AkSteps from './AkSteps.svelte';
  import { filled, isSecretKey, otherFieldErrors, probeText, type Handle, type Message } from './messages';
  import Notice from './Notice.svelte';

  export let state: SetupState;
  export let handle: Handle;
  /** the public address (redirect URI = <public address>/auth/callback) */
  export let publicUrl: string;
  const dispatch = createEventDispatcher<{ done: void }>();

  const REQUIRED = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'ADMIN_GROUP'] as const;
  const OPTIONAL = ['AUTHENTIK_URL', 'AUTHENTIK_API_TOKEN', 'AUTHENTIK_ENROLL_FLOW'] as const;
  let mode: 'auto' | 'manual' = 'auto';
  let values: Record<string, string> = Object.fromEntries([...REQUIRED, ...OPTIONAL].map((k) => [k, '']));
  let busy: 'save' | 'test' | 'force' | null = null;
  let msg: Message | null = null;
  let ok = '';

  $: typed = filled(values);
  $: insecure = isPlainHttp(values.OIDC_ISSUER ?? '') || isPlainHttp(values.AUTHENTIK_URL ?? '');
  $: others = otherFieldErrors(msg?.fields, [...REQUIRED, ...OPTIONAL]);
  $: fieldErr = (key: string) => (msg?.fields?.[key] ? fieldText(msg.fields[key]!) : '');

  function setMode(m: 'auto' | 'manual') { mode = m; msg = null; ok = ''; }

  async function test() {
    if (busy) return;
    busy = 'test'; msg = null; ok = '';
    try {
      const r = await testSetup('signin', typed);
      if (r.ok) ok = probeText(r);
      else msg = { kind: 'message', text: probeText(r), probe: r };
    } catch (e) { msg = handle(e); } finally { busy = null; }
  }

  async function save(force = false) {
    if (busy) return;
    busy = force ? 'force' : 'save'; msg = null; ok = '';
    try {
      await saveSetup(typed, force);
      values = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, isSecretKey(k) ? '' : v]));
      dispatch('done');
    } catch (e) { msg = handle(e); } finally { busy = null; }
  }
</script>

<h2 id="setup-step-h">{$t('setup.signin.title')}</h2>
<p>{$t('setup.signin.text')}</p>
{#if state.steps.signin === 'done'}<p class="muted">{$t('setup.doneText')}</p>{/if}

<div class="seg" role="group" aria-label={$t('setup.signin.modeLabel')}>
  <button type="button" class:on={mode === 'auto'} aria-pressed={mode === 'auto'} on:click={() => setMode('auto')}>{$t('setup.signin.auto')}</button>
  <button type="button" class:on={mode === 'manual'} aria-pressed={mode === 'manual'} on:click={() => setMode('manual')}>{$t('setup.signin.manual')}</button>
</div>

{#if mode === 'auto'}
  <AkSteps {handle} on:done />
{:else}
  <form novalidate on:submit|preventDefault={() => save()}>
    <p>{$t('setup.signin.manualText')}</p>
    <section class="check" aria-labelledby="ss-chk">
      <h3 id="ss-chk">{$t('setup.signin.checklistTitle')}</h3>
      <CopyField label={$t('setup.signin.redirect')} value={redirectUri(publicUrl)} />
      <ul>
        <li>{$t('setup.signin.checklist.consent')}</li>
        <li>{$t('setup.signin.checklist.grant')}</li>
        <li>{$t('setup.signin.checklist.client')}</li>
        <li>{$t('setup.signin.checklist.scopes')}</li>
      </ul>
    </section>
    {#each REQUIRED as key (key)}
      <Field label={keyLabel(key)} hint={keyHelp(key)} error={fieldErr(key)} let:id let:describedby let:invalid>
        <input {id} type={isSecretKey(key) ? 'password' : 'text'} inputmode={key === 'OIDC_ISSUER' ? 'url' : undefined} autocomplete="off" spellcheck="false"
          maxlength={4096} bind:value={values[key]} aria-describedby={describedby} aria-invalid={invalid} />
      </Field>
    {/each}
    <h3>{$t('setup.signin.optional')}</h3>
    {#each OPTIONAL as key (key)}
      <Field label={keyLabel(key)} hint={keyHelp(key)} error={fieldErr(key)} let:id let:describedby let:invalid>
        <input {id} type={isSecretKey(key) ? 'password' : 'text'} inputmode={key === 'AUTHENTIK_URL' ? 'url' : undefined} autocomplete="off" spellcheck="false"
          maxlength={4096} bind:value={values[key]} aria-describedby={describedby} aria-invalid={invalid} />
      </Field>
    {/each}
    {#if insecure}<Notice tone="warn"><p>{$t('setup.signin.insecure')}</p></Notice>{/if}
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
      <Button variant="secondary" icon="activity" pending={busy === 'test'} disabled={!Object.keys(typed).length} on:click={test}>{$t('setup.test')}</Button>
      <Button type="submit" icon="check" pending={busy === 'save'} disabled={!Object.keys(typed).length}>{$t('setup.saveNext')}</Button>
    </div>
  </form>
{/if}

<style>
  form { display: grid; gap: .8rem; }
  form > p { margin: 0; }
  h3 { margin: .4rem 0 0; font-size: 1.05rem; }
  .check { display: grid; gap: .6rem; padding: .8rem; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); min-width: 0; }
  .check h3 { margin: 0; }
  .check ul { margin: 0; padding-left: 1.2rem; display: grid; gap: .3rem; overflow-wrap: anywhere; }
  .acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .6rem; }
  .seg { display: inline-flex; gap: .25rem; padding: .25rem; margin-bottom: 1rem; border-radius: 8px; background: var(--surface); border: 1px solid var(--line); max-width: 100%; }
  .seg button { min-height: 44px; padding: .4rem 1rem; border-radius: 6px; background: transparent; color: var(--fg); border: 0; font-weight: 600; }
  .seg button.on { background: var(--fg); color: var(--bg); }
  @media (max-width: 480px) { .acts > :global(*) { flex: 1 1 100%; } .seg { display: flex; } .seg button { flex: 1; } }
</style>
