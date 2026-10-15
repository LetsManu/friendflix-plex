<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * /me/account, profile: name and colour (PATCH /api/account/profile, only the changed fields). The e-mail is shown read-only here;
   * it is changed in the security section's e-mail row (re-authentication and a confirmation link to the new address).
   */
  import { createEventDispatcher } from 'svelte';
  import { api, ApiError, type Account } from '#lib/api';
  import { AVATARS, avatarBg, initial } from '#lib/avatars';
  import Icon from '#lib/Icon.svelte';
  import { t, tr, type TKey } from '#lib/i18n';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';

  export let account: Account;
  const dispatch = createEventDispatcher<{ saved: Account }>();
  const KEY = 'account:profile';
  let name = account.name, avatar = account.avatar, err = '';

  $: trimmed = name.trim();
  $: changes = { ...(trimmed !== account.name ? { name: trimmed } : {}), ...(avatar !== account.avatar ? { avatar } : {}) };
  $: dirty = Object.keys(changes).length > 0;
  const colorKey = (key: string) => `account.profiles.colors.${key}` as TKey;

  function failText(e: unknown, sent: { name?: string }): string {
    if (!(e instanceof ApiError)) return errorText(e);
    if ((e.body as { error?: string } | null)?.error === 'name_taken') return tr('account.account.profile.nameTaken');
    if (e.status === 400 && sent.name !== undefined) return tr('account.account.profile.nameInvalid'); // the server refused the name (e.g. characters)
    if (e.status === 502 || e.status === 503) return tr('account.account.profile.signInRefused'); // Authentik refused or is down
    return errorText(e);
  }
  async function save() {
    err = '';
    if (!trimmed || trimmed.length > 60) { err = tr('account.account.profile.nameInvalid'); return; }
    if (!dirty) return;
    const body = changes;
    const r = await runAction({ key: KEY, run: () => api<Account>('/api/account/profile', { method: 'PATCH', body }), success: tr('account.account.profile.saved'), error: false });
    if (r.ok && r.value) dispatch('saved', r.value);
    else if (!r.skipped) err = failText(r.error, body);
  }
</script>

<section class="panel card" aria-labelledby="acc-profile">
  <h2 id="acc-profile">{$t('account.account.profile.title')}</h2>
  <form on:submit|preventDefault={save}>
    <div class="who">
      <span class="face" style="background:{avatarBg(avatar)}" aria-hidden="true">{initial(trimmed || account.name)}</span>
      <label class="field">{$t('account.account.profile.name')}
        <input bind:value={name} maxlength="60" autocomplete="name" required aria-invalid={err ? 'true' : undefined} aria-describedby={err ? 'acc-profile-err' : undefined} on:input={() => (err = '')} />
      </label>
    </div>
    <fieldset>
      <legend>{$t('account.account.profile.avatar')}</legend>
      <div class="cols">
        {#each AVATARS as [key, , css] (key)}
          <button type="button" class="sw" class:sel={avatar === key} style="background:{css}" aria-label={$t(colorKey(key))} aria-pressed={avatar === key} on:click={() => (avatar = key)}>{#if avatar === key}<Icon name="check" size={20} />{/if}</button>
        {/each}
      </div>
    </fieldset>
    {#if err}<p class="err" id="acc-profile-err" role="alert">{err}</p>{/if}
    <div class="acts"><Button type="submit" disabled={!dirty} pending={$busyKeys.has(KEY)}>{$t('account.account.profile.save')}</Button></div>
  </form>

  <div class="mail">
    <span class="lbl">{$t('account.account.profile.email')}</span>
    {#if account.email}<span class="val">{account.email}</span>{:else}<span class="val muted">{$t('account.account.profile.noEmail')}</span>{/if}
    <p class="muted hint">{$t('account.account.profile.emailHint')}</p>
    <a class="ext" href="#sec-email">{$t('account.account.profile.emailManage')}</a>
  </div>
</section>

<style>
  .card { display: flex; flex-direction: column; gap: 1rem; margin: 0; min-width: 0; }
  h2 { font-size: 1.15rem; margin: 0; }
  form { display: flex; flex-direction: column; gap: 1rem; }
  .who { display: flex; align-items: flex-end; gap: 1rem; }
  .face { width: 64px; height: 64px; flex: none; border-radius: 24%; display: grid; place-items: center; font-size: 1.8rem; font-weight: 800; box-shadow: 0 0 0 1px rgba(255,255,255,.12); }
  .field { display: flex; flex-direction: column; gap: .35rem; flex: 1; min-width: 0; font-weight: 600; }
  .field input { width: 100%; min-height: 44px; }
  fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: .5rem; min-width: 0; }
  legend { font-weight: 600; padding: 0; margin-bottom: .5rem; }
  .cols { display: flex; flex-wrap: wrap; gap: .5rem; }
  .sw { width: 44px; min-height: 44px; padding: 0; border-radius: 24%; box-shadow: 0 0 0 1px rgba(255,255,255,.15); }
  .sw.sel { box-shadow: 0 0 0 3px #fff; }
  .sw:hover:not(:disabled) { filter: brightness(1.15); }
  .err { margin: 0; }
  .acts { display: flex; }
  @media (max-width: 600px) { .acts :global(button) { width: 100%; } }
  .mail { display: flex; flex-direction: column; gap: .2rem; border-top: 1px solid var(--line); padding-top: 1rem; min-width: 0; }
  .lbl { font-weight: 600; }
  .val { overflow-wrap: anywhere; }
  .hint { margin: .2rem 0 0; font-size: .9rem; }
  .ext { display: inline-flex; align-items: center; gap: .4rem; min-height: 44px; color: #54b9c5; font-weight: 600; align-self: flex-start; }
  .ext:hover { text-decoration: underline; }
</style>
