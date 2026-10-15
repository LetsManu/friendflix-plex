<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * /me/account, security: the 2FA state at Authentik (read-only) and the link to its user settings. Changing the password
   * or 2FA inside FriendFlix comes later, so there are no actions here.
   */
  import type { Account } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { t, type TKey } from '#lib/i18n';
  import StatusPill from '#lib/ui/StatusPill.svelte';

  export let account: Account;
  const METHODS = ['totp', 'webauthn', 'static'] as const;
  const methodKey = (m: (typeof METHODS)[number]) => `account.account.security.methods.${m}` as TKey;
</script>

<section class="panel card" aria-labelledby="acc-security">
  <h2 id="acc-security">{$t('account.account.security.title')}</h2>
  <div class="tf">
    <h3 id="acc-2fa">{$t('account.account.security.twoFactor')}</h3>
    {#if account.mfa}
      <ul class="chips" aria-labelledby="acc-2fa">
        {#each METHODS as m (m)}
          {@const on = account.mfa[m]}
          <li><span class="method">{$t(methodKey(m))}</span> <StatusPill tone={on ? 'ok' : 'muted'} label={on ? $t('account.account.security.on') : $t('account.account.security.off')} /></li>
        {/each}
      </ul>
    {:else}
      <p class="na"><StatusPill tone="muted" icon="info" label={$t('account.account.security.notAvailable')} /> <span class="muted">{$t('account.account.security.notAvailableHint')}</span></p>
    {/if}
  </div>
  {#if account.manageUrl}
    <a class="ext" href={account.manageUrl} target="_blank" rel="noopener noreferrer">{$t('account.account.security.manage')}<span class="sr-only"> {$t('account.account.security.newTab')}</span><Icon name="link" size={16} /></a>
  {/if}
  <p class="muted note"><Icon name="info" size={16} />{$t('account.account.security.coming')}</p>
</section>

<style>
  .card { display: flex; flex-direction: column; gap: 1rem; margin: 0; min-width: 0; }
  h2 { font-size: 1.15rem; margin: 0; }
  h3 { font-size: 1rem; margin: 0 0 .6rem; }
  .chips { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
  .chips li { display: flex; align-items: center; justify-content: space-between; gap: .8rem; min-height: 36px; padding: .3rem .8rem; background: var(--surface-2); border-radius: 8px; }
  .method { min-width: 0; overflow-wrap: anywhere; }
  .na { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
  .ext { display: inline-flex; align-items: center; gap: .4rem; min-height: 44px; color: #54b9c5; font-weight: 600; align-self: flex-start; }
  .ext:hover { text-decoration: underline; }
  .note { display: flex; gap: .5rem; align-items: flex-start; margin: 0; font-size: .9rem; }
  .note :global(svg) { margin-top: .15rem; }
</style>
