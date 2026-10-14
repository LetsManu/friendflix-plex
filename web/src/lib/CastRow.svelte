<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { api, img } from '#lib/api';
  import { t, type TKey } from '#lib/i18n';

  interface Member { id: string; name: string; role?: string; type: string; image: boolean }
  /** item whose cast & crew is shown; the section stays hidden while loading, on failure or when empty */
  export let id: string;
  /** already loaded by the parent (DetailView): no second /people request; undefined = fetch here */
  export let people: Member[] | undefined = undefined;
  let fetched: Member[] = [], seq = 0;
  $: shown = (people ?? fetched).slice(0, 20);

  $: if (people === undefined) void load(id);
  async function load(itemId: string) {
    const my = ++seq;
    fetched = [];
    try {
      const r = await api(`/api/items/${itemId}/people`);
      if (my === seq) fetched = ((r?.people ?? []) as Member[]).slice(0, 20);
    } catch { /* optional section */ }
  }
  const ROLE: Record<string, TKey> = { Director: 'detail.cast.role.director', Writer: 'detail.cast.role.writer', Producer: 'detail.cast.role.producer', Composer: 'detail.cast.role.composer' };
  const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
</script>

{#if shown.length}
  <section class="cast" aria-labelledby="cast-h">
    <h2 id="cast-h">{$t('detail.cast.title')}</h2>
    <ul>
      {#each shown as p, n (p.id + ':' + n)}
        <li><a href="/person/{p.id}">
          <span class="av">{#if p.image}<img src={img(p.id, 160)} alt="" loading="lazy" width="72" height="72" />{:else}<span aria-hidden="true">{initials(p.name)}</span>{/if}</span>
          <span class="nm">{p.name}</span>
          {#if p.role || ROLE[p.type]}<span class="muted rl">{p.role || $t(ROLE[p.type]!)}</span>{/if}
        </a></li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .cast { margin-top: 2rem; }
  ul { list-style: none; padding: 0 0 .5rem; margin: 0; display: flex; gap: 1rem; overflow-x: auto; scrollbar-width: thin; }
  a { display: flex; flex-direction: column; align-items: center; gap: .25rem; width: 104px; min-height: 44px; text-align: center; }
  .av { width: 72px; height: 72px; border-radius: 50%; overflow: hidden; background: var(--surface-2); display: grid; place-items: center; font-weight: 700; color: var(--mut); }
  .av img { width: 100%; height: 100%; object-fit: cover; }
  .nm { font-size: .88rem; font-weight: 600; line-height: 1.25; overflow-wrap: anywhere; }
  .rl { font-size: .78rem; line-height: 1.2; overflow-wrap: anywhere; }
  a:hover .nm { text-decoration: underline; }
</style>
