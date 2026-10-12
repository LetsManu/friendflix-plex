<script lang="ts">
  /** Renders lib/ui/toast.ts. Mounted once in the root layout; pages never mount it. */
  import { fly, fade } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import Icon from '#lib/Icon.svelte';
  import { t } from '#lib/i18n';
  import { close, pause, resume, runToastAction, toasts, type ToastKind } from './toast';
  import { dur } from './motion';
  const ICON: Record<ToastKind, string> = { success: 'check', error: 'alert', info: 'info' };
  let inside = false;
  function enter() { if (!inside) { inside = true; pause(); } }
  function leave(e?: FocusEvent) {
    const to = e?.relatedTarget as Node | null;
    if (e && to && (e.currentTarget as HTMLElement).contains(to)) return;
    if (inside) { inside = false; resume(); }
  }
  /** Escape closes the toast that has focus */
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-toast]');
    if (li) { e.stopPropagation(); close(Number(li.dataset.toast)); }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (hover/focus pause the timers; Escape closes the focused toast) -->
<section class="toasts" aria-label={$t('ui.notifications')} on:mouseenter={enter} on:mouseleave={() => leave()} on:focusin={enter} on:focusout={leave} on:keydown={onKey}>
  <ol aria-live="polite" aria-relevant="additions text">
    {#each $toasts as m (m.id)}
      <li class="toast {m.kind}" animate:flip={{ duration: dur(180) }} in:fly={{ y: 16, duration: dur(200) }} out:fade={{ duration: dur(140) }} data-toast={m.id}>
        <span class="ic" aria-hidden="true"><Icon name={ICON[m.kind]} size={18} /></span>
        <p class="msg">{#if m.kind === 'error'}<span class="sr-only">{$t('ui.errorPrefix')} </span>{/if}{m.message}</p>
        {#if m.action}<button type="button" class="act" on:click={() => runToastAction(m.id)}>{m.action.label}</button>{/if}
        <button type="button" class="x" aria-label={$t('ui.dismiss')} on:click={() => close(m.id)}><Icon name="x" size={18} /></button>
      </li>
    {/each}
  </ol>
</section>

<style>
  .toasts { position: fixed; z-index: 120; right: 1.2rem; bottom: 1.2rem; width: min(420px, calc(100vw - 2rem)); pointer-events: none; }
  ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
  .toast { pointer-events: auto; display: flex; align-items: center; gap: .6rem; padding: .45rem .45rem .45rem .9rem; min-height: 52px; background: #262626; color: var(--fg); border-radius: 8px; border: 1px solid #3a3a3a; border-left: 4px solid var(--mut); box-shadow: var(--shadow-pop); }
  .success { border-left-color: var(--ok); } .success .ic { color: var(--ok); }
  .error { border-left-color: var(--err); } .error .ic { color: var(--err); }
  .info { border-left-color: var(--info); } .info .ic { color: var(--info); }
  .ic { flex: none; display: grid; }
  .msg { flex: 1; margin: 0; font-size: .93rem; line-height: 1.35; overflow-wrap: anywhere; }
  .act { flex: none; background: transparent; color: var(--info); padding: 0 .7rem; font-weight: 700; }
  .act:hover:not(:disabled) { background: rgba(84,185,197,.12); }
  .x { flex: none; width: 44px; padding: 0; background: transparent; color: var(--mut); border-radius: 50%; }
  .x:hover:not(:disabled) { background: rgba(255,255,255,.08); color: var(--fg); }
  @media (max-width: 720px) {
    /* above the phone tab bar */
    .toasts { left: 50%; right: auto; transform: translateX(-50%); bottom: calc(56px + env(safe-area-inset-bottom) + .6rem); }
  }
  :global(html.tv) .toasts { bottom: 2rem; right: 2rem; }
</style>
