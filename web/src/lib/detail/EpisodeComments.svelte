<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '#lib/api';
  import { kidsMode } from '#lib/kids';
  import { fmtRelative, t } from '#lib/i18n';

  /** episode (or movie) id */
  export let itemId: string;
  /** called with the number of comments after each load / change */
  export let onCount: (n: number) => void = () => undefined;

  interface Comment { id: string; name: string; mine: boolean; spoiler: boolean; body?: string; createdAt: string; canDelete: boolean }
  const MAX = 1000;
  let comments: Comment[] | null = null, watched = true, text = '', busy = false, err = '', failed = false, revealed = new Set<string>(), revealing = false;

  async function load(reveal = false) {
    try {
      const r = await api<{ watched: boolean; comments: Comment[] }>(`/api/items/${itemId}/comments${reveal ? '?reveal=1' : ''}`);
      comments = r.comments; watched = r.watched; failed = false;
      onCount(comments.length);
    } catch (e) {
      if (e instanceof ApiError && e.body?.error === 'kids_profile') kidsMode.set(true); // stale flag: the server knows better
      else failed = true;
    }
  }
  onMount(() => { void load(); });

  /** hidden bodies are not sent until asked for: reveal fetches them once for the whole list */
  async function reveal(id: string) {
    if (revealing) return;
    revealing = true;
    if (comments?.some((c) => c.spoiler && c.body === undefined)) await load(true);
    revealed = new Set([...revealed, id]);
    revealing = false;
  }
  async function send() {
    const body = text.trim();
    if (!body || busy || body.length > MAX) return;
    busy = true; err = '';
    try {
      const c = await api<Comment>(`/api/items/${itemId}/comments`, { method: 'POST', body: { body } });
      comments = [c, ...(comments ?? [])];
      text = '';
      onCount(comments.length);
    } catch (e) {
      err = e instanceof ApiError && e.status === 429 ? $t('anime.comments.tooMany') : $t('anime.comments.failed');
    }
    busy = false;
  }
  async function remove(c: Comment) {
    try {
      await api(`/api/comments/${c.id}`, { method: 'DELETE' });
      comments = (comments ?? []).filter((x) => x.id !== c.id);
      onCount(comments.length);
    } catch { err = $t('anime.comments.failed'); }
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } };
</script>

<div class="cm" role="region" aria-label={$t('anime.comments.title')}>
  {#if !watched}<p class="muted hint">{$t('anime.comments.hint')}</p>{/if}
  <form on:submit|preventDefault={send}>
    <label class="sr-only" for="cm-{itemId}">{$t('anime.comments.label')}</label>
    <textarea id="cm-{itemId}" rows="2" maxlength={MAX} placeholder={$t('anime.comments.placeholder')} bind:value={text} on:keydown={onKey}></textarea>
    <div class="sendrow">
      <span class="muted cnt" class:over={text.length > MAX - 50}>{$t('anime.comments.chars', { n: text.length, max: MAX })}</span>
      <button type="submit" disabled={busy || !text.trim()}>{$t('anime.comments.send')}</button>
    </div>
  </form>
  {#if err}<p class="warn" role="alert">{err}</p>{/if}
  {#if failed}<p class="warn" role="alert">{$t('anime.comments.loadFailed')}</p>
  {:else if comments === null}<div class="skeleton sk"></div>
  {:else if !comments.length}<p class="muted">{$t('anime.comments.empty')}</p>
  {:else}
    <ul>
      {#each comments as c (c.id)}
        <li>
          <div class="meta"><b>{c.mine ? $t('anime.comments.you') : c.name}</b><span class="muted">{fmtRelative(c.createdAt)}</span>
            {#if c.canDelete}<button type="button" class="lnk del" aria-label={$t('anime.comments.deleteAria', { name: c.name })} on:click={() => remove(c)}>{$t('anime.comments.delete')}</button>{/if}</div>
          {#if c.spoiler && !revealed.has(c.id)}
            <!-- the text is not in the DOM until the viewer asks for it -->
            <p class="blur" aria-hidden="true">{'█'.repeat(24)}</p>
            <button type="button" class="lnk" disabled={revealing} on:click={() => reveal(c.id)}>{$t('anime.comments.reveal')}</button>
          {:else}
            <p class="body">{c.body ?? ''}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .cm { padding: .2rem .8rem 1rem 3.6rem; display: flex; flex-direction: column; gap: .6rem; }
  .hint { margin: 0; font-size: .88rem; }
  form { display: flex; flex-direction: column; gap: .4rem; }
  textarea { width: 100%; resize: vertical; min-height: 3.2rem; box-sizing: border-box; font: inherit; }
  .sendrow { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  .cnt { font-size: .8rem; font-variant-numeric: tabular-nums; } .cnt.over { color: var(--warn, #f5c518); }
  .sk { height: 3rem; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .8rem; }
  .meta { display: flex; gap: .6rem; align-items: baseline; font-size: .9rem; }
  .meta .del { margin-left: auto; }
  /* plain text only: white-space keeps the author's line breaks, nothing is ever interpreted as markup */
  .body { margin: .15rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .blur { margin: .15rem 0; filter: blur(5px); user-select: none; color: var(--mut); letter-spacing: -.05em; }
  .lnk { background: none; border: 0; padding: 0; min-height: 0; color: var(--fg); text-decoration: underline; cursor: pointer; font: inherit; font-size: .88rem; font-weight: 400; display: inline; }
  .lnk:hover:not(:disabled) { background: none; }
  @media (max-width: 640px) { .cm { padding-left: .5rem; padding-right: .5rem; } }
</style>
