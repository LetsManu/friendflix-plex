<script lang="ts">
  import { fmtDate as fmtD, t, tr, type TKey } from '#lib/i18n';
  import { api, ApiError } from '#lib/api';
  import Icon from '#lib/Icon.svelte';

  type Emoji = 'like' | 'funny' | 'wow' | 'sad' | 'love';
  interface Reaction { name: string; emoji: Emoji; comment?: string; mine: boolean; createdAt: string }
  type Data = { locked: true; count?: number } | { locked: false; count: number; summary: Partial<Record<Emoji, number>>; reactions: Reaction[] };

  /** movie or episode id */
  export let id: string;
  const EMOJIS: Array<{ key: Emoji; icon: string; label: TKey }> = [
    { key: 'like', icon: '👍', label: 'detail.reactions.emoji.like' },
    { key: 'funny', icon: '😂', label: 'detail.reactions.emoji.funny' },
    { key: 'wow', icon: '😮', label: 'detail.reactions.emoji.wow' },
    { key: 'sad', icon: '😢', label: 'detail.reactions.emoji.sad' },
    { key: 'love', icon: '❤️', label: 'detail.reactions.emoji.love' },
  ];
  const MAX = 280;
  let data: Data | null = null, msg = '', msgOk = false, busy = false, seq = 0, msgT: ReturnType<typeof setTimeout>;
  let emoji: Emoji | null = null, comment = '';

  $: void load(id);
  function adopt(d: Data) {
    data = d;
    if (!d.locked) {
      const mine = d.reactions.find((r) => r.mine);
      emoji = mine?.emoji ?? null; comment = mine?.comment ?? '';
    }
  }
  async function load(itemId: string) {
    const my = ++seq;
    data = null; msg = ''; emoji = null; comment = '';
    try {
      const d = await api<Data>(`/api/items/${itemId}/reactions`);
      if (my === seq) adopt(d);
    } catch { /* optional: section stays hidden (unsupported type, offline, ...) */ }
  }
  function fail(e: unknown, fallback: string) {
    msg = e instanceof ApiError && e.body?.error === 'watch_first' ? tr('detail.reactions.watchFirst') : fallback; msgOk = false;
    clearTimeout(msgT); msgT = setTimeout(() => (msg = ''), 6000);
  }
  async function save() {
    if (!emoji || busy) return;
    busy = true; msg = '';
    const my = ++seq;
    try {
      const d = await api<Data>(`/api/items/${id}/reactions`, { method: 'PUT', body: { emoji, comment: comment.trim() || undefined } });
      if (my === seq) { adopt(d); msg = tr('detail.reactions.saved'); msgOk = true; clearTimeout(msgT); msgT = setTimeout(() => (msg = ''), 3000); }
    } catch (e) { fail(e, tr('detail.reactions.saveFailed')); }
    busy = false;
  }
  async function remove() {
    if (busy) return;
    busy = true; msg = '';
    const my = ++seq;
    try {
      const d = await api<Data>(`/api/items/${id}/reactions`, { method: 'DELETE' });
      if (my === seq) { adopt(d); emoji = null; comment = ''; msg = tr('detail.reactions.deleted'); msgOk = true; clearTimeout(msgT); msgT = setTimeout(() => (msg = ''), 3000); }
    } catch (e) { fail(e, tr('detail.reactions.deleteFailed')); }
    busy = false;
  }
  const label = (k: Emoji) => EMOJIS.find((e) => e.key === k);
  const fmtDate = (s: string) => fmtD(s, { day: 'numeric', month: 'short' });
  $: mineExists = !!(data && !data.locked && data.reactions.some((r) => r.mine));
</script>

{#if data}
  <section class="reactions panel" aria-labelledby="rx-h">
    <h2 id="rx-h">{$t('detail.reactions.title')}</h2>
    {#if data.locked}
      <p class="lock"><Icon name="lock" size={20} /><span>{data.count ? $t('detail.reactions.lockedCount', { n: data.count }) : $t('detail.reactions.locked')}</span></p>
    {:else}
      <div class="chips" role="group" aria-label={$t('detail.reactions.yours')}>
        {#each EMOJIS as e (e.key)}
          <button type="button" class="chip sec" class:on={emoji === e.key} aria-pressed={emoji === e.key} disabled={busy} on:click={() => (emoji = emoji === e.key ? null : e.key)}>
            <span aria-hidden="true">{e.icon}</span><span>{$t(e.label)}</span><span class="n">{data.summary[e.key] ?? 0}</span>
          </button>
        {/each}
      </div>
      <form class="form" on:submit|preventDefault={save}>
        <label for="rx-c" class="muted">{$t('detail.reactions.comment')}</label>
        <textarea id="rx-c" bind:value={comment} maxlength={MAX} rows="3" aria-describedby="rx-n" placeholder={$t('detail.reactions.placeholder')}></textarea>
        <div class="foot">
          <span id="rx-n" class="muted">{comment.length}/{MAX}</span>
          <span class="btns">
            {#if mineExists}<button type="button" class="sec" disabled={busy} on:click={remove}>{$t('detail.reactions.delete')}</button>{/if}
            <button type="submit" disabled={busy || !emoji}>{$t('detail.reactions.save')}</button>
          </span>
        </div>
      </form>
      {#if data.reactions.length}
        <ul class="list">
          {#each data.reactions as r}
            <li class:mine={r.mine}>
              <span class="em" role="img" aria-label={label(r.emoji) ? $t(label(r.emoji)!.label) : r.emoji}>{label(r.emoji)?.icon ?? ''}</span>
              <div class="txt">
                <b>{r.mine ? $t('detail.reactions.you') : r.name}</b> <span class="muted">{fmtDate(r.createdAt)}</span>
                {#if r.comment}<p>{r.comment}</p>{/if}
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted">{$t('detail.reactions.none')}</p>
      {/if}
    {/if}
    <div role="status">{#if msg}<p class={msgOk ? 'muted' : 'err'}>{msg}</p>{/if}</div>
  </section>
{/if}

<style>
  .reactions { margin-top: 1.2rem; }
  .lock { display: flex; gap: .6rem; align-items: center; margin: .4rem 0; color: var(--mut); }
  .chips { display: flex; flex-wrap: wrap; gap: .5rem; margin: .6rem 0; }
  .chip { display: inline-flex; align-items: center; gap: .4rem; min-height: 44px; padding-inline: .9rem; border-radius: 99px; }
  .chip.on { background: #fff; color: #000; }
  .n { font-variant-numeric: tabular-nums; opacity: .75; }
  .form { display: flex; flex-direction: column; gap: .4rem; margin-bottom: 1rem; }
  textarea { width: 100%; box-sizing: border-box; resize: vertical; }
  .foot { display: flex; justify-content: space-between; align-items: center; gap: .6rem; flex-wrap: wrap; }
  .btns { display: inline-flex; gap: .5rem; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .7rem; }
  .list li { display: flex; gap: .7rem; align-items: flex-start; }
  .em { font-size: 1.4rem; line-height: 1.6; min-width: 2rem; text-align: center; }
  .txt p { margin: .2rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .mine .txt b { color: var(--acc); }
</style>
