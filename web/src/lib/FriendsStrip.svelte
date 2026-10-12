<script lang="ts">
  import { api } from '#lib/api';
  import { t } from '#lib/i18n';

  interface Friend { id: string; name: string; stars?: number; watched?: boolean; recommended?: boolean }
  /** item whose friend activity is shown; the section stays hidden while loading, on failure or when empty */
  export let id: string;
  let friends: Friend[] = [], seq = 0;

  $: void load(id);
  async function load(itemId: string) {
    const my = ++seq;
    friends = [];
    try {
      const r = await api(`/api/items/${itemId}/friends`);
      if (my === seq) friends = (r?.friends ?? []) as Friend[];
    } catch { /* optional section */ }
  }
  const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  const facts = (f: Friend, recommends: string, watched: string) => [f.recommended && recommends, f.stars && `★${f.stars}`, f.watched && watched].filter(Boolean) as string[];
</script>

{#if friends.length}
  <section class="fr" aria-labelledby="fr-h">
    <h2 id="fr-h">{$t('detail.friends.title')}</h2>
    <ul>
      {#each friends as f (f.id)}
        <li>
          <span class="av" aria-hidden="true">{initials(f.name)}</span>
          <span class="tx"><b>{f.name}</b>
            <span class="muted">{#each facts(f, $t('detail.friends.recommends'), $t('detail.friends.watched')) as fact, n}{n ? ' · ' : ''}{fact}{/each}</span></span>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .fr { margin: 1rem 0; }
  ul { list-style: none; padding: 0 0 .5rem; margin: 0; display: flex; gap: .7rem; overflow-x: auto; scrollbar-width: thin; }
  li { display: flex; align-items: center; gap: .6rem; min-height: 44px; padding: .4rem .9rem .4rem .5rem; background: var(--surface); border: 1px solid var(--line); border-radius: 99px; flex: 0 0 auto; max-width: 100%; }
  .av { width: 36px; height: 36px; border-radius: 50%; background: var(--surface-2); display: grid; place-items: center; font-weight: 700; font-size: .85rem; color: var(--mut); flex: 0 0 auto; }
  .tx { display: flex; flex-direction: column; line-height: 1.25; font-size: .88rem; min-width: 0; }
  .tx b { overflow-wrap: anywhere; }
</style>
