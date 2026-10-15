<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The e-mail row of the security section: the current address, "Ändern" (re-authentication, then the new address and the confirmation
   * link: the parent opens the dialog), and while a change waits for its link "Bestätigung ausstehend an a•••@…". Without the e-mail
   * change flow in Authentik the button is hidden; admins are told it is not set up.
   */
  import { createEventDispatcher } from 'svelte';
  import { t } from '#lib/i18n';
  import Button from '#lib/ui/Button.svelte';

  export let email: string | null;
  /** masked address of a pending change */
  export let pending: string | null;
  /** the flow exists in Authentik */
  export let available: boolean;
  export let isAdmin = false;

  const dispatch = createEventDispatcher<{ change: void }>();
</script>

<div class="row">
  <div class="what">
    <h3 id="sec-email">{$t('login.sec.email.title')}</h3>
    <p class="val">{email ?? $t('login.sec.email.none')}</p>
    {#if pending}<p class="muted note" role="status">{$t('login.sec.email.pending', { to: pending })}</p>{/if}
    {#if !available && isAdmin}<p class="muted note">{$t('login.sec.email.notSetUp')}</p>{/if}
  </div>
  {#if available}
    <div class="acts"><Button variant="secondary" size="sm" aria-describedby="sec-email" on:click={() => dispatch('change')}>{$t('login.sec.email.change')}</Button></div>
  {/if}
</div>

<style>
  .row { display: flex; align-items: center; justify-content: space-between; gap: .8rem; flex-wrap: wrap; }
  .what { min-width: 0; flex: 1 1 14rem; }
  h3 { font-size: 1rem; margin: 0 0 .2rem; }
  .val { margin: 0; overflow-wrap: anywhere; }
  .note { margin: .2rem 0 0; font-size: .88rem; }
  @media (max-width: 600px) { .row { flex-direction: column; align-items: stretch; } .acts :global(.ui-btn) { width: 100%; } }
</style>
