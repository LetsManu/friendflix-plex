<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The field errors of the last answer, in a polite live region (always in the DOM, so a new error is announced). Too many attempts
   * also offers the classic sign-in page. Texts are FriendFlix's own (by code); nothing from Authentik is shown here.
   */
  import { t } from '#lib/i18n';
  import { errorKey, type FlowError } from './flow';
  export let errors: FlowError[] = [];
  export let classicHref: string;
  /** a local message (e.g. a malformed invite) shown like a field error */
  export let extra = '';
</script>

<div class="af-errs" class:has={Boolean(extra) || errors.length > 0} aria-live="polite">{#if extra}<p>{extra}</p>{/if}{#each errors as e (e)}<p>{$t(errorKey(e))}</p>{/each}{#if errors.includes('rate_limited')}<a class="af-link" href={classicHref}>{$t('login.errors.classic')}</a>{/if}</div>
