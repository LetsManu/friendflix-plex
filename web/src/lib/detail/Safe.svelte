<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Error boundary for one optional section of the detail page: a throw while rendering it (odd data of one title) removes only this
   * section instead of turning the whole page into SvelteKit's "Internal Error". SvelteKit still passes the error to
   * handleError (hooks.client.ts: console + client error log), so it stays visible to the admin.
   */
  /** a change (e.g. the next title in the same view) rebuilds the section, so a failed one gets another try */
  export let key: unknown = undefined;
  /** section name for the log */
  export let name: string;
  function failed(e: unknown) {
    console.warn(`[detail] section "${name}" left out:`, e instanceof Error ? e.message : e);
  }
</script>

{#key key}<svelte:boundary onerror={failed}><slot /></svelte:boundary>{/key}
