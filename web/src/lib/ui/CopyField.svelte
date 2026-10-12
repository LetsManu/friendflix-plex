<script lang="ts">
  /**
   * Read-only value with a Copy button (toast on success) and an optional QR code (lib/qr.ts, rendered as SVG).
   *   <CopyField label={$t('admin.invites.oneTimeLink')} value={link} qr />
   */
  import Icon from '#lib/Icon.svelte';
  import { qrPath } from '#lib/qr';
  import { t, tr } from '#lib/i18n';
  import { toast } from './toast';
  import { uid } from './ids';
  export let label: string;
  export let value: string;
  export let qr = false;
  export let hint = '';
  export let id = uid('copy');
  let input: HTMLInputElement, showQr = false;
  $: code = showQr && value ? qrPath(value) : null;

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else { input.select(); if (!document.execCommand('copy')) throw new Error('copy'); }
      toast.success(tr('ui.copy.copied'), { key: 'ui-copy' });
    } catch {
      input?.select();
      toast.error(tr('ui.copy.failed'), { key: 'ui-copy' });
    }
  }
</script>

<div class="cf">
  <label for={id}>{label}</label>
  <div class="row">
    <input {id} bind:this={input} readonly {value} on:focus={() => input.select()} aria-describedby={hint ? `${id}-h` : undefined} />
    <button type="button" class="sec" on:click={copy}><Icon name="copy" size={18} />{$t('ui.copy.copy')}</button>
    {#if qr}<button type="button" class="ghost icon" aria-pressed={showQr} aria-label={showQr ? $t('ui.copy.qrHide') : $t('ui.copy.qrShow')} title={$t('ui.copy.qr')} on:click={() => (showQr = !showQr)}><Icon name="qr" size={20} /></button>{/if}
  </div>
  {#if hint}<span class="hint" id="{id}-h">{hint}</span>{/if}
  {#if code}
    <svg class="qr" viewBox="-2 -2 {code.size + 4} {code.size + 4}" role="img" aria-label={$t('ui.copy.qr')} shape-rendering="crispEdges"><rect x="-2" y="-2" width={code.size + 4} height={code.size + 4} fill="#fff" /><path d={code.d} fill="#000" /></svg>
  {/if}
</div>

<style>
  .cf { display: flex; flex-direction: column; gap: .35rem; min-width: 0; }
  .row { display: flex; gap: .5rem; min-width: 0; }
  input { flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88rem; }
  .icon { width: 44px; padding: 0; flex: none; }
  .hint { font-size: .82rem; color: var(--mut); }
  .qr { width: 180px; height: 180px; border-radius: 8px; margin-top: .4rem; }
  @media (max-width: 420px) { .row { flex-wrap: wrap; } input { flex-basis: 100%; } }
</style>
