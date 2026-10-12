<script lang="ts">
  /** Admin → Abstimmungen: closed polls whose winner is not in the library yet wait here for approval (creates a wish). */
  import { onMount } from 'svelte';
  import { api, ApiError } from '#lib/api';
  import Icon from '#lib/Icon.svelte';
  import { fmtDateTime, t, tr } from '#lib/i18n';
  import { bumpPending, refreshSummary } from '#lib/admin/summary';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import Progress from '#lib/ui/Progress.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';

  interface Option { id: number; title: string | null; hidden?: boolean; inLibrary?: boolean; mediaType?: string; votes: number }
  interface Poll { id: string; title: string; creator: string; closesAt?: string; winnerOptionId: number | null; options: Option[] }

  let polls: Poll[] | null = null, failed = false;
  async function load() {
    failed = false;
    try { polls = (await api<{ polls: Poll[] }>('/api/admin/polls')).polls; } catch { polls = []; failed = true; }
  }
  onMount(load);

  const total = (p: Poll) => p.options.reduce((a, o) => a + o.votes, 0);
  const winner = (p: Poll) => p.options.find((o) => o.id === p.winnerOptionId);
  const optTitle = (o: Option) => o.hidden || !o.title ? tr('adminContent.polls.hiddenTitle') : o.title;

  const take = (p: Poll) => () => {
    const prev = polls;
    polls = (polls ?? []).filter((x) => x !== p);
    bumpPending('polls', -1);
    return () => { polls = prev; bumpPending('polls', 1); };
  };
  const failText = (e: unknown) => e instanceof ApiError && e.status === 502 ? tr('adminContent.polls.seerrDown')
    : e instanceof ApiError && e.status === 409 ? tr('adminContent.polls.alreadyHandled') : errorText(e);
  const done = (res: { ok: boolean; error?: unknown }) => {
    if (res.ok) void refreshSummary();
    else if (res.error instanceof ApiError && res.error.status === 409) void load(); // someone else was faster
  };

  function approve(p: Poll) {
    void runAction({
      key: `poll:${p.id}`, apply: take(p), error: failText,
      run: () => api(`/api/admin/polls/${p.id}/approve`, { method: 'POST' }),
      success: tr('adminContent.polls.approved', { title: winner(p) ? optTitle(winner(p)!) : p.title }),
    }).then(done);
  }
  function reject(p: Poll) {
    void runAction({
      key: `poll:${p.id}`, defer: true, apply: take(p), error: failText,
      run: () => api(`/api/admin/polls/${p.id}/reject`, { method: 'POST' }),
      success: tr('adminContent.polls.rejected', { title: p.title }),
    }).then(done);
  }
</script>

<p class="intro muted">{$t('admin.polls.intro')}</p>

{#if polls === null}
  <div class="list" aria-hidden="true">
    {#each [0, 1] as i (i)}<div class="poll"><Skeleton w="50%" h="1.2rem" /><div class="opts"><Skeleton h="2.6rem" /><Skeleton h="2.6rem" /></div><Skeleton w="12rem" h="2.5rem" /></div>{/each}
  </div>
  <p class="sr-only" role="status">{$t('ui.table.loading')}</p>
{:else if failed}
  <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('adminContent.polls.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div>
{:else if !polls.length}
  <div class="state"><Icon name="check" size={22} /><p>{$t('admin.polls.none')}</p></div>
{:else}
  <ul class="list">
    {#each polls as p (p.id)}
      {@const busy = $busyKeys.has(`poll:${p.id}`)}
      {@const sum = total(p)}
      <li class="poll" aria-busy={busy ? 'true' : undefined}>
        <header>
          <h2>{p.title}</h2>
          <p class="meta muted">{[$t('adminContent.polls.by', { name: p.creator }), p.closesAt ? $t('adminContent.polls.closed', { date: fmtDateTime(p.closesAt) }) : ''].filter(Boolean).join(' · ')}</p>
        </header>
        <ul class="opts" aria-label={$t('adminContent.polls.results', { title: p.title })}>
          {#each p.options as o (o.id)}
            {@const win = o.id === p.winnerOptionId}
            <li class:win>
              <div class="oh">
                <span class="ot">{#if win}<Icon name="crown" size={16} />{/if}{optTitle(o)}</span>
                {#if win}<StatusPill tone="ok" icon="check" label={$t('adminContent.polls.winner')} />{/if}
                {#if o.inLibrary === false}<StatusPill tone="warn" icon="inbox" label={$t('adminContent.polls.notInLibrary')} />{/if}
              </div>
              <Progress value={o.votes} max={Math.max(sum, 1)} tone={win ? 'ok' : 'acc'} label={$t('adminContent.polls.votes', { n: o.votes })} showValue />
            </li>
          {/each}
        </ul>
        <div class="acts">
          <Button icon="check" pending={busy} on:click={() => approve(p)}>{$t('admin.approve')}</Button>
          <Button variant="ghost" icon="x" disabled={busy} on:click={() => reject(p)}>{$t('admin.decline')}</Button>
        </div>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .intro { margin: 0 0 1rem; max-width: 70ch; }
  .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); }
  .poll { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: .9rem; min-width: 0; transition: opacity var(--t-fast); }
  .poll[aria-busy='true'] { opacity: .6; }
  h2 { margin: 0; font-size: 1.1rem; overflow-wrap: anywhere; }
  .meta { margin: .15rem 0 0; font-size: .88rem; }
  .opts { list-style: none; margin: 0; padding: 0; display: grid; gap: .8rem; }
  .opts li { display: grid; gap: .3rem; padding: .55rem .7rem; border-radius: 6px; background: rgba(255,255,255,.03); border: 1px solid transparent; }
  .opts li.win { border-color: rgba(70, 211, 105, .45); background: var(--tone-ok); }
  .oh { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  .ot { flex: 1 1 8rem; min-width: 0; display: inline-flex; align-items: center; gap: .4rem; font-weight: 600; overflow-wrap: anywhere; }
  .acts { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: auto; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 2.4rem 1rem; color: var(--mut); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .state p { margin: 0; }
  .state[role='alert'] { color: var(--fg); }
  .state[role='alert'] :global(svg) { color: var(--err); }
  @media (max-width: 560px) { .acts > :global(*) { flex: 1; } }
</style>
