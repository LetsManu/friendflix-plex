<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts" module>
  /** the export: only the account's own data, as one JSON file (an attachment) */
  export const EXPORT_URL = '/api/account/export';
</script>
<script lang="ts">
  /** /me/account, your data: a plain download link (GET /api/account/export answers as an attachment, the browser streams it). */
  import Button from '#lib/ui/Button.svelte';
  import { t } from '#lib/i18n';
</script>

<section class="panel card" aria-labelledby="acc-data">
  <h2 id="acc-data">{$t('account.account.data.title')}</h2>
  <div class="acts"><Button variant="secondary" icon="download" href={EXPORT_URL} download="">{$t('account.account.data.download')}</Button></div>
  <p class="muted hint">{$t('account.account.data.hint')}</p>
</section>

<style>
  .card { display: flex; flex-direction: column; gap: 1rem; margin: 0; min-width: 0; }
  h2 { font-size: 1.15rem; margin: 0; }
  .hint { margin: 0; font-size: .9rem; }
  .acts { display: flex; }
  @media (max-width: 600px) { .acts :global(.btn) { width: 100%; } }
</style>
