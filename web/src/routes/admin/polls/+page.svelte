<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import { t } from '#lib/i18n';
  let polls: any[] = [];
  const load = async () => (polls = (await api('/api/admin/polls')).polls);
  onMount(load);
  async function act(id: string, a: 'approve' | 'reject') { await api(`/api/admin/polls/${id}/${a}`, { method: 'POST' }); load(); }
</script>
<p class="muted">{$t('admin.polls.intro')}</p>
{#each polls as p}
  {@const w = p.options.find((o: any) => o.id === p.winnerOptionId)}
  <div class="panel flex"><b>{p.title}</b> {$t('admin.polls.winner', { title: w?.title ?? '?' })} <span class="muted">({p.creator})</span><button on:click={() => act(p.id, 'approve')}>{$t('admin.approve')}</button><button class="sec" on:click={() => act(p.id, 'reject')}>{$t('admin.decline')}</button></div>
{:else}<p class="muted">{$t('admin.polls.none')}</p>{/each}
