<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte';
  import { api, ApiError, img, type Item } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtList, fmtNumber, t } from '#lib/i18n';
  import { facts, otherTitles, type CastInfoData, type CreditPerson } from './castinfo';

  /**
   * Player side panel "Besetzung & Infos": cast with their characters, guest stars of the episode, background facts.
   * A person opens a sheet with more titles of the library featuring them (the server only lists titles this profile can see)
   * and a link to /person. Shown while paused (as before) or opened explicitly; it never pauses playback itself.
   * Escape / Back are handled by the player (capture phase): with the person sheet open they press its [data-back] button.
   */
  export let data: CastInfoData | null;
  export let failed = false;
  /** focus the first entry when opened from the remote / keyboard */
  export let autofocus = false;
  const dispatch = createEventDispatcher<{ close: void }>();

  let sel: CreditPerson | null = null, titles: Item[] | null = null, titlesFailed = false, seq = 0, root: HTMLElement, opener: HTMLElement | null = null;
  async function pick(p: CreditPerson, e: Event) {
    opener = e.currentTarget as HTMLElement;
    sel = p; titles = null; titlesFailed = false;
    const my = ++seq;
    await tick(); root?.querySelector<HTMLElement>('.sheet [data-first]')?.focus();
    try {
      const r = await api<{ items: Item[] }>(`/api/people/${p.id}`);
      if (my === seq) titles = data ? otherTitles(r.items ?? [], data.item) : [];
    } catch (err) {
      if (my !== seq) return;
      titles = []; titlesFailed = !(err instanceof ApiError && err.status === 404); // 404 = nothing visible to this profile
    }
  }
  async function back() { sel = null; seq++; await tick(); (opener && root?.contains(opener) ? opener : root?.querySelector<HTMLElement>('.person'))?.focus(); }
  $: sections = data ? [{ key: 'scenes.info.cast' as const, list: data.cast }, { key: 'scenes.info.guests' as const, list: data.guests }] : [];
  $: rows = data ? facts(data, (n) => fmtNumber(n), (xs) => fmtList(xs)) : [];
  onMount(() => { if (autofocus) void tick().then(() => (root?.querySelector<HTMLElement>('.person') ?? root?.querySelector<HTMLElement>('.close'))?.focus()); });
  const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (clicks must not reach the play/pause surface, arrows not the player's seek / volume keys) -->
<aside class="ci ui" bind:this={root} data-nav data-scope aria-label={$t('scenes.info.title')} on:click|stopPropagation on:keydown={(e) => { if (e.key.startsWith('Arrow')) e.stopPropagation(); }}>
  <header>
    {#if sel}
      <button type="button" class="icx" data-back aria-label={$t('scenes.person.back')} on:click={back}><Icon name="chevron-left" size={22} /></button>
      <h3>{sel.name}</h3>
    {:else}
      <h3>{$t('scenes.info.title')}</h3>
    {/if}
    <button type="button" class="icx close" aria-label={$t('scenes.info.close')} on:click={() => dispatch('close')}><Icon name="x" size={20} /></button>
  </header>
  <div class="body">
    {#if sel}
      <div class="sheet">
        <div class="who">
          {#if sel.image}<img class="av big" src={img(sel.id, 240)} alt="" />{:else}<span class="av big ph" aria-hidden="true">{initials(sel.name)}</span>{/if}
          <div>{#if sel.role}<p class="muted">{$t('scenes.person.role', { role: sel.role })}</p>{/if}
            <a class="btn sec small" href="/person/{sel.id}" data-first>{$t('scenes.person.page')}</a></div>
        </div>
        <h4>{$t('scenes.person.more', { name: sel.name })}</h4>
        {#if titles === null}<p class="muted" role="status">{$t('scenes.person.loading')}</p>
        {:else if !titles.length}<p class="muted" role="status">{titlesFailed ? $t('scenes.person.failed') : $t('scenes.person.none')}</p>
        {:else}
          <ul class="titles">{#each titles as it (it.id)}
            <li><a href="/item/{it.id}" title={it.name}>{#if it.image}<img src={img(it.id, 200)} alt="" loading="lazy" />{:else}<span class="tph"><Icon name="film" size={22} /></span>{/if}<span class="tn">{it.name}{it.year ? ` (${it.year})` : ''}</span></a></li>
          {/each}</ul>
        {/if}
      </div>
    {:else if !data}
      <p class="muted" role="status">{failed ? $t('scenes.info.failed') : $t('scenes.info.loading')}</p>
    {:else}
      {#each sections as sec (sec.key)}
        {#if sec.list.length}
          <h4>{$t(sec.key)}</h4>
          <ul class="people">{#each sec.list as p (p.id)}
            <li><button type="button" class="person" aria-label={$t('scenes.info.person', { name: p.name })} on:click={(e) => pick(p, e)}>
              {#if p.image}<img class="av" loading="lazy" src={img(p.id, 120)} alt="" />{:else}<span class="av ph" aria-hidden="true">{initials(p.name)}</span>{/if}
              <span class="nm"><b>{p.name}</b>{#if p.role}<small>{$t('scenes.info.as', { role: p.role })}</small>{/if}</span>
            </button></li>{/each}</ul>
        {/if}
      {/each}
      {#if !data.cast.length && !data.guests.length}<p class="muted">{$t('scenes.info.none')}</p>{/if}
      {#if rows.length}
        <h4>{$t('scenes.info.facts')}</h4>
        <dl>{#each rows as r}<dt>{$t(r.key)}</dt><dd>{#if r.people}{#each r.people as p, i}{i ? ', ' : ''}<a href="/person/{p.id}">{p.name}</a>{/each}{:else}{r.text}{/if}</dd>{/each}</dl>
      {/if}
    {/if}
  </div>
</aside>

<style>
  .ci { position: absolute; z-index: 7; left: clamp(.6rem, 2.4vw, 2.4rem); top: 4.8rem; bottom: 9rem; width: min(360px, calc(100% - 1.2rem - var(--inset, 0px))); display: flex; flex-direction: column;
    background: rgba(14,14,14,.9); border: 1px solid #333; border-radius: 10px; box-shadow: 0 12px 30px rgba(0,0,0,.6); overflow: hidden; animation: ciIn var(--t-med, .2s) ease-out; }
  @keyframes ciIn { from { opacity: 0; transform: translateX(-12px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .ci { animation: none; } }
  header { display: flex; align-items: center; gap: .3rem; padding: .5rem .5rem .4rem 1rem; border-bottom: 1px solid #2a2a2a; }
  header h3 { flex: 1; margin: 0; font-size: 1rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header .icx:first-child { margin-left: -.6rem; }
  .icx { background: transparent; padding: 0; width: 44px; min-height: 44px; color: var(--mut); border-radius: 50%; flex: none; }
  .icx:hover:not(:disabled) { background: rgba(255,255,255,.12); color: #fff; }
  .body { overflow-y: auto; overscroll-behavior: contain; padding: .2rem .6rem .8rem; }
  h4 { margin: .8rem .4rem .4rem; font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--mut); }
  ul { list-style: none; margin: 0; padding: 0; }
  .person { display: flex; align-items: center; gap: .7rem; width: 100%; padding: .35rem .4rem; background: transparent; color: #fff; text-align: left; justify-content: flex-start; border-radius: 6px; font-weight: 400; min-height: 52px; }
  .person:hover:not(:disabled), .person:focus-visible { background: rgba(255,255,255,.1); }
  .av { flex: none; width: 44px; height: 44px; border-radius: 50%; object-fit: cover; background: #333; }
  .ph { display: grid; place-items: center; font-weight: 700; font-size: .85rem; color: #bbb; }
  .av.big { width: 88px; height: 88px; font-size: 1.4rem; }
  .nm { display: grid; min-width: 0; line-height: 1.25; } .nm b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nm small { color: var(--mut); font-size: .82rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .35rem .8rem; margin: 0 .4rem; font-size: .9rem; }
  dt { color: var(--mut); } dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  dd a { color: #fff; } dd a:hover, dd a:focus-visible { text-decoration: underline; }
  .who { display: flex; gap: .9rem; align-items: center; margin: .6rem .4rem; } .who p { margin: 0 0 .5rem; }
  .small { padding: .35rem .9rem; font-size: .85rem; min-height: 38px; }
  .titles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .5rem; padding: 0 .4rem; }
  .titles a { display: grid; gap: .25rem; color: #ddd; text-decoration: none; font-size: .78rem; border-radius: 6px; }
  .titles a:hover .tn, .titles a:focus-visible .tn { color: #fff; text-decoration: underline; }
  .titles img, .tph { width: 100%; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 5px; background: #2a2a2a; display: grid; place-items: center; color: var(--mut); }
  .tn { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.2; }
  p.muted { margin: .6rem .4rem; }
  :global(html.tv) .person { min-height: 60px; font-size: 1.05rem; }
  /* phones: a sheet across the width between the top bar and the two-row control bar */
  @media (max-width: 720px) { .ci { left: .5rem; right: .5rem; width: auto; top: 4.2rem; bottom: 9.6rem; } }
  @media (max-height: 520px) { .ci { top: .6rem; bottom: 6.2rem; } }
</style>
