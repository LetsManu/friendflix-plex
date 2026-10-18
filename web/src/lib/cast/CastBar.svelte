<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * The cast bar: what plays on the TV while the person browses (mounted by the root layout, which decides when it shows).
   * Phone: docked directly above the tab bar (`tabbar = false`: at the bottom edge, e.g. kids profiles); desktop: at the
   * bottom edge, as wide as the content. The layout makes room for it with `--castbar-h`.
   */
  import { onDestroy, tick as settled } from 'svelte';
  import { goto } from '$app/navigation';
  import { get } from 'svelte/store';
  import Icon from '#lib/Icon.svelte';
  import { t, tr } from '#lib/i18n';
  import { confirm } from '#lib/ui/confirm';
  import { barLine, barProgress, barThumb, nextSecondsLeft } from './bar';
  import { castEngine, castSession } from './engine';

  /** a tab bar sits below the bar (phone): false = the bar docks at the bottom edge */
  export let tabbar = true;

  const airState = castEngine.airState;
  $: s = $castSession;
  $: state = s?.state;
  /** play / pause only drives a TV that plays (connecting / reconnect / failed / ended have no live token) */
  $: live = state === 'playing';
  /** AirPlay waits for the TV to be chosen in the system picker (it may not have opened without a fresh tap) */
  $: choose = s?.kind === 'airplay' && state === 'reconnect' && Boolean($airState?.ready);
  $: thumb = s ? barThumb(s) : null;
  $: progress = s ? Math.round(barProgress(s)) : 0;

  /** the next-episode countdown (from the credits on, or after the end) ticks once a second while it runs */
  let now = Date.now(), tick: ReturnType<typeof setInterval> | undefined;
  $: startsAt = state === 'ended' || live ? s?.next?.startsAt ?? null : null;
  $: if (startsAt !== null && tick === undefined) { now = Date.now(); tick = setInterval(() => (now = Date.now()), 1000); }
  $: if (startsAt === null && tick !== undefined) { clearInterval(tick); tick = undefined; }
  onDestroy(() => clearInterval(tick));
  $: secs = nextSecondsLeft(startsAt, now);
  $: next = state === 'ended' || live ? s?.next ?? null : null;
  /** intro / recap on the TV: skip it from here */
  $: skip = live ? s?.skip ?? null : null;

  let region: HTMLDivElement | undefined;
  /**
   * A focused button can give way to another (Next -> spinner, reconnect -> playing): keyboard focus then moves to the
   * remote button (else "Play here" / Stop) instead of falling back to the page. Runs before the DOM update.
   */
  $: keepFocus(state, Boolean(next), choose);
  function keepFocus(..._changed: unknown[]) {
    if (!region?.contains(document.activeElement)) return;
    void settled().then(() => {
      if (!region || region.contains(document.activeElement)) return;
      region.querySelector<HTMLElement>('button.main, button.here, button.stop')?.focus();
    });
  }

  $: line2 = !s ? ''
    : state === 'reconnect' ? (choose ? $t('player.airplay.chooseHint') : $t('player.castBar.reconnect'))
    : next ? [$t('player.castBar.next', { label: next.label }), secs !== null ? $t('player.castBar.nextIn', { n: secs }) : ''].filter(Boolean).join(' · ')
    : barLine(s, $t);

  /** text / thumb: opens the remote (the watch page attaches); "Play here" in `failed`: the session is dropped, the title plays here */
  function open() {
    const c = get(castSession);
    if (!c) return;
    if (c.state === 'failed') castEngine.release();
    void goto('/watch/' + c.itemId);
  }
  /** `reconnect`: runs inside the tap (AirPlay opens the system picker, which needs the gesture) */
  function reconnect() { castEngine.reconnect(); }
  function playPause() { if (get(castSession)?.state === 'playing') castEngine.playPause(); }
  async function stop() {
    const c = get(castSession);
    if (!c) return;
    if (await confirm({ title: tr('player.castBar.stopQuestion', { device: c.device }), danger: true, confirmLabel: tr('player.castBar.stop', { device: c.device }) })) await castEngine.stop();
  }
</script>

{#if s}
  <div class="castbar" bind:this={region} class:notab={!tabbar} role="region" aria-label={$t('player.castBar.region')} aria-busy={state === 'connecting' ? 'true' : undefined}>
    <div class="box">
      <div class="line" role="progressbar" aria-label={$t('player.castBar.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style="width:{progress}%"></span></div>
      {#if state === 'reconnect'}
        <!-- the whole bar (but Stop) is one button: the tap reconnects -->
        <button type="button" class="main" on:click={reconnect}>
          {#if thumb}<img class="thumb" src={thumb.src} alt="" style="aspect-ratio:{thumb.ratio}" />{/if}
          <span class="txt"><span class="t1">{s.title}</span><span class="t2 hint">{line2}</span></span>
        </button>
        {#if choose}<button type="button" class="act" aria-label={$t('player.airplay.choose')} title={$t('player.airplay.choose')} on:click={reconnect}><Icon name="airplay" size={24} /></button>{/if}
      {:else}
        {#snippet info()}
          {#if thumb}<img class="thumb" src={thumb.src} alt="" style="aspect-ratio:{thumb.ratio}" />{/if}
          <span class="txt" id="castbar-txt"><span class="t1">{s.title}</span>{#if line2}<span class="t2">{line2}</span>{/if}</span>
        {/snippet}
        {#if state === 'failed'}
          <!-- the title can't play on the TV: no remote to open; "Play here" is the action -->
          <div class="main">{@render info()}</div>
        {:else}
          <!-- named by its action; the title and the second line are its description -->
          <button type="button" class="main" aria-label={$t('player.castBar.open')} aria-describedby="castbar-txt" on:click={open}>{@render info()}</button>
        {/if}
        {#if state === 'connecting'}
          <span class="act spin-slot" aria-hidden="true"><span class="spin"></span></span>
        {:else if state === 'failed'}
          <button type="button" class="here" on:click={open}>{$t('player.castBar.playHere')}</button>
        {:else if next}
          {#if secs !== null}<button type="button" class="act" aria-label={$t('common.cancel')} title={$t('common.cancel')} on:click={() => castEngine.cancelNext()}><Icon name="x" size={22} /></button>{/if}
          <button type="button" class="act" aria-label={$t('player.castBar.next', { label: next.label })} on:click={() => void castEngine.next()}><Icon name="skip-next" size={24} /></button>
        {:else}
          {#if skip}<button type="button" class="skipb" on:click={() => castEngine.skipSegment()}>{$t(skip.type === 'recap' ? 'player.skip.recap' : 'player.skip.intro')}</button>{/if}
          {#if live && s.isEpisode}<button type="button" class="act" aria-label={$t('player.controls.next')} title={$t('player.controls.next')} on:click={() => void castEngine.next()}><Icon name="skip-next" size={24} /></button>{/if}
          <button type="button" class="act pp" aria-disabled={live ? undefined : 'true'} aria-label={$t(s.paused ? 'player.controls.play' : 'player.controls.pause')} on:click={playPause}>
            <Icon name={s.paused ? 'play' : 'pause'} size={24} />
          </button>
        {/if}
      {/if}
      <button type="button" class="act stop" aria-label={$t('player.castBar.stop', { device: s.device })} title={$t('player.castBar.stop', { device: s.device })} on:click={stop}><Icon name="stop" size={22} /></button>
    </div>
  </div>
{/if}

<style>
  .castbar { position: fixed; z-index: 81; left: 0; right: 0; bottom: calc(56px + var(--safe-bottom)); height: 64px; animation: up .22s ease-out; }
  .castbar.notab { bottom: var(--safe-bottom); }
  .box { position: relative; height: 100%; display: flex; align-items: center; gap: .25rem; padding: 0 .5rem 0 0; background: var(--card); overflow: hidden; }
  .line { position: absolute; left: 0; right: 0; top: 0; height: 2px; }
  .line span { display: block; height: 100%; background: var(--acc); transition: width .4s linear; }
  button { color: inherit; background: none; border: 0; padding: 0; cursor: pointer; font: inherit; }
  div.main { cursor: default; }
  .skipb { flex: none; min-height: 40px; padding: 0 .7rem; border: 1px solid var(--line, #3b444e); border-radius: var(--radius); font-size: .85rem; white-space: nowrap; }
  .main { flex: 1 1 auto; min-width: 0; height: 100%; cursor: pointer; min-height: 48px; display: flex; align-items: center; gap: .7rem; padding-left: var(--pad-x); text-align: left; }
  .thumb { flex: none; height: 44px; width: auto; object-fit: cover; border-radius: var(--radius); }
  .txt { min-width: 0; display: flex; flex-direction: column; }
  .t1, .t2 { display: block; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .t1 { font-weight: 600; }
  .t2 { font-size: .85rem; color: var(--mut); }
  .t2.hint { color: var(--acc); }
  .act { flex: none; width: 48px; height: 48px; display: grid; place-items: center; border-radius: var(--radius); }
  .pp { background: var(--acc-fill, var(--acc)); color: #fff; }
  .pp[aria-disabled='true'] { opacity: .5; cursor: default; }
  .here { flex: none; min-height: 48px; padding: 0 .9rem; border-radius: var(--radius); background: var(--acc-fill, var(--acc)); color: #fff; font-weight: 600; white-space: nowrap; }
  .spin { width: 24px; height: 24px; border: 3px solid var(--mut); border-top-color: var(--acc); border-radius: 50%; animation: sp .8s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }
  @keyframes up { from { transform: translateY(100%); opacity: 0; } }
  @media (min-width: 721px) {
    .castbar, .castbar.notab { bottom: 0; max-width: 1500px; margin: 0 auto; padding: 0 var(--pad-x); }
    .box { border-radius: var(--radius) var(--radius) 0 0; }
    .main { padding-left: .5rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    .castbar { animation: none; }
    .spin { animation: none; }
    .line span { transition: none; }
  }
</style>
