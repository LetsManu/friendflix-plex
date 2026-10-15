<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** A wizard message: `err` is an alert, the others a status (never colour alone: every tone has an icon). */
  import Icon from '#lib/Icon.svelte';
  export let tone: 'ok' | 'warn' | 'err' | 'info' = 'info';
  const ICON = { ok: 'check', warn: 'alert', err: 'alert', info: 'info' } as const;
</script>

<div class="notice {tone}" role={tone === 'err' ? 'alert' : 'status'}>
  <Icon name={ICON[tone]} size={18} />
  <div class="body"><slot /></div>
</div>

<style>
  .notice { display: flex; gap: .6rem; align-items: flex-start; padding: .65rem .8rem; border-radius: 6px; border: 1px solid var(--line); background: var(--tone-info); min-width: 0; }
  .notice :global(svg) { flex: none; margin-top: .15rem; }
  .body { display: grid; gap: .45rem; justify-items: start; min-width: 0; overflow-wrap: anywhere; }
  .body :global(p) { margin: 0; }
  .ok { background: var(--tone-ok); }
  .ok :global(svg) { color: var(--ok); }
  .warn { background: var(--tone-warn); }
  .warn :global(svg) { color: var(--warn); }
  .err { background: var(--tone-err); }
  .err :global(svg) { color: var(--err); }
</style>
