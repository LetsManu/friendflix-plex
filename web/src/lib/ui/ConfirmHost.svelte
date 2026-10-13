<script lang="ts">
  /** Renders lib/ui/confirm.ts as a modal alertdialog. Mounted once in the root layout. */
  import { onMount, tick } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  import { dialogKeys } from '#lib/actions';
  import { t } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { answer, confirmRequest, registerHost, typedOk } from './confirm';
  import { dur } from './motion';

  onMount(registerHost);
  let box: HTMLElement | undefined, typedVal = '', back: HTMLElement | null = null, shownId = 0;
  $: req = $confirmRequest;
  $: ok = typedOk(req?.typed, typedVal);
  $: if (req && req.id !== shownId) void opened(req.id);
  $: if (!req && shownId) closed();

  async function opened(id: number) {
    if (!shownId) back = document.activeElement as HTMLElement | null;
    shownId = id; typedVal = '';
    await tick();
    const first = box?.querySelector<HTMLElement>(req?.typed ? 'input' : req?.danger ? '.cancel' : '.ok');
    first?.focus();
  }
  function closed() {
    shownId = 0;
    const el = back; back = null;
    if (el?.isConnected) el.focus({ preventScroll: true });
  }
  function submit() { if (ok) answer(true); }
</script>

{#if req}
  <!-- svelte-ignore a11y_click_events_have_key_events (Escape is handled by dialogKeys) -->
  <div class="ov" transition:fade={{ duration: dur(140) }} role="presentation" on:click|self={() => answer(false)}>
    <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="cf-t" aria-describedby={req.body ? 'cf-b' : undefined} bind:this={box}
      in:scale={{ start: .96, duration: dur(160) }} use:dialogKeys={{ close: () => answer(false) }}><form on:submit|preventDefault={submit}>
      <div class="head">
        {#if req.danger}<span class="ic" aria-hidden="true"><Icon name="alert" size={22} /></span>{/if}
        <h2 id="cf-t">{req.title}</h2>
      </div>
      {#if req.body}<p id="cf-b" class="body">{req.body}</p>{/if}
      {#if req.typed}
        <label class="typed"><span>{$t('ui.confirm.typeToConfirm', { word: req.typed })}</span>
          <input bind:value={typedVal} autocomplete="off" autocapitalize="off" spellcheck="false" />
        </label>
      {/if}
      <div class="acts">
        <button type="button" class="sec cancel" on:click={() => answer(false)}>{req.cancelLabel ?? $t('ui.confirm.cancel')}</button>
        <button type="submit" class="ok" class:danger={req.danger} class:solid={req.danger} disabled={!ok}>{req.confirmLabel ?? (req.danger ? $t('ui.confirm.delete') : $t('ui.confirm.ok'))}</button>
      </div>
    </form></div>
  </div>
{/if}

<style>
  .ov { position: fixed; inset: 0; z-index: 130; background: rgba(0,0,0,.7); display: grid; place-items: center; padding: max(1rem, var(--safe-top)) 1rem max(1rem, var(--safe-bottom)); }
  .dlg { width: min(460px, 100%); background: #1b2127; border: 1px solid #323a43; border-radius: 12px; padding: 1.4rem 1.4rem 1.2rem; box-shadow: var(--shadow-pop); }
  .head { display: flex; align-items: center; gap: .7rem; }
  .ic { display: grid; place-items: center; width: 40px; height: 40px; flex: none; border-radius: 50%; background: var(--tone-err); color: var(--err); }
  h2 { margin: 0; font-size: 1.2rem; }
  .body { color: var(--mut); margin: .8rem 0 0; white-space: pre-line; overflow-wrap: anywhere; }
  .typed { display: flex; flex-direction: column; gap: .35rem; margin-top: 1rem; }
  .typed input { width: 100%; }
  .acts { display: flex; justify-content: flex-end; gap: .6rem; margin-top: 1.4rem; flex-wrap: wrap; }
  @media (max-width: 420px) { .acts { flex-direction: column-reverse; } .acts button { width: 100%; } }
</style>
