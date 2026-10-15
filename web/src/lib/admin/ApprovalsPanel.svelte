<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin: approval queue (tab of /admin/users) – people who signed in without an invite. Approve with a role and an
   * optional access-until, or reject with an optional message (shown on their waiting page). Reports the open count.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { api, ApiError } from '#lib/api';
  import { fmtDateTime, fmtRelative, t, tr } from '#lib/i18n';
  import { accessPreset, futureDayEnd, today } from '#lib/admin/people';
  import { roleName, type RoleInfo } from '#lib/roles';
  import { errorText, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import Field from '#lib/ui/Field.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';

  export let roles: Record<string, RoleInfo> = {};
  /** the roles an approval may grant */
  export let invitable: string[] = ['friend', 'family', 'guest'];

  interface R { id: string; name: string; email: string | null; requested_at: string }
  /** per request: chosen role, access choice ('' = unlimited, p30, p90, date), its day, reject form */
  interface Draft { role: string; access: string; day: string; rejecting: boolean; message: string }
  const dispatch = createEventDispatcher<{ count: number }>();
  let rows: R[] | null = null, error: string | null = null;
  let drafts: Record<string, Draft> = {};

  const defaultRole = () => (invitable.includes('friend') ? 'friend' : invitable[0] ?? 'friend');
  async function load() {
    try {
      rows = (await api<{ requests: R[] }>('/api/admin/approvals')).requests;
      drafts = Object.fromEntries(rows.map((r) => [r.id, drafts[r.id] ?? { role: defaultRole(), access: '', day: '', rejecting: false, message: '' }]));
      error = null;
      dispatch('count', rows.length);
    } catch { error = tr('adminPeople.loadFailed'); }
  }
  onMount(() => { void load(); });
  const set = (id: string, patch: Partial<Draft>) => { drafts = { ...drafts, [id]: { ...drafts[id]!, ...patch } }; };
  const val = (e: Event): string => (e.target as HTMLInputElement | HTMLSelectElement).value;

  $: roleOptions = invitable.map((k) => ({ value: k, label: roleName(k, roles[k]) }));
  $: accessOptions = [
    { value: '', label: $t('adminPeople.access.unlimited') }, { value: 'p30', label: $t('adminPeople.access.p30') },
    { value: 'p90', label: $t('adminPeople.access.p90') }, { value: 'date', label: $t('adminPeople.access.date') },
  ];

  /** access-until for the API: undefined = no end; null = the chosen day is missing or past (it would lock at once) */
  function accessUntil(d: Draft): string | undefined | null {
    if (d.access === 'p30' || d.access === 'p90') return accessPreset(d.access === 'p30' ? '+30' : '+90') ?? undefined;
    if (d.access === 'date') return futureDayEnd(d.day) || null;
    return undefined;
  }

  /** 404 / 409: someone else already approved or rejected it (or the person has an account by now) */
  const handled = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 409);
  /** takes only this request out of the list; the rollback puts only it back (other cards handled meanwhile stay gone) */
  function withdraw(r: R): () => void {
    rows = (rows ?? []).filter((x) => x.id !== r.id);
    dispatch('count', rows.length);
    return () => {
      if (!rows || rows.some((x) => x.id === r.id)) return;
      rows = [...rows, r].sort((a, b) => a.requested_at.localeCompare(b.requested_at) || a.id.localeCompare(b.id));
      dispatch('count', rows.length);
    };
  }
  async function decide(r: R, run: () => Promise<unknown>, success: string) {
    const res = await runAction({
      key: `apr:${r.id}`, apply: () => withdraw(r), run, success,
      error: (e) => (handled(e) ? tr('adminPeople.approvals.alreadyHandled', { name: r.name }) : errorText(e)),
    });
    if (!res.ok && handled(res.error)) void load(); // the server's list drops the card again
  }
  function approve(r: R) {
    const d = drafts[r.id]!;
    const until = accessUntil(d);
    if (until === null) return;
    void decide(r, () => api(`/api/admin/approvals/${r.id}/approve`, { method: 'POST', body: { role: d.role, ...(until ? { accessUntil: until } : {}) } }),
      tr('adminPeople.approvals.approved', { name: r.name }));
  }
  function reject(r: R) {
    const message = drafts[r.id]!.message.trim();
    void decide(r, () => api(`/api/admin/approvals/${r.id}/reject`, { method: 'POST', body: message ? { message } : {} }),
      tr('adminPeople.approvals.rejected', { name: r.name }));
  }
</script>

<p class="intro">{$t('adminPeople.approvals.intro')}</p>
{#if error}
  <div class="state err" role="alert"><p>{error}</p><Button variant="secondary" icon="refresh" on:click={() => { error = null; rows = null; void load(); }}>{$t('ui.retry')}</Button></div>
{:else if rows === null}
  <div class="list" aria-busy="true">{#each Array(2) as _, i (i)}<div class="req"><Skeleton w="40%" h="1.1rem" /><Skeleton w="60%" h=".9rem" /></div>{/each}</div>
{:else if !rows.length}
  <p class="state">{$t('adminPeople.approvals.empty')}</p>
{:else}
  <div class="list">
    {#each rows as r (r.id)}
      {@const d = drafts[r.id]}
      {#if d}
        <section class="req" aria-labelledby="apr-{r.id}">
          <div class="who">
            <h3 id="apr-{r.id}">{r.name}</h3>
            <p class="sub">{r.email ?? $t('adminPeople.approvals.noEmail')} · <time datetime={r.requested_at} title={fmtDateTime(r.requested_at)}>{$t('adminPeople.approvals.requested', { time: fmtRelative(r.requested_at) })}</time></p>
          </div>
          <div class="choose">
            <Select label={$t('adminPeople.approvals.role')} options={roleOptions} value={d.role} on:change={(e) => set(r.id, { role: val(e) })} />
            <Select label={$t('adminPeople.access.label')} options={accessOptions} value={d.access} on:change={(e) => set(r.id, { access: val(e) })} />
            {#if d.access === 'date'}<Field type="date" label={$t('adminPeople.access.day')} value={d.day} min={today()} required on:input={(e) => set(r.id, { day: val(e) })} on:change={(e) => set(r.id, { day: val(e) })} />{/if}
          </div>
          <div class="acts">
            <Button icon="check" disabled={d.access === 'date' && !futureDayEnd(d.day)} on:click={() => approve(r)}>{$t('adminPeople.approvals.approve')}</Button>
            {#if !d.rejecting}<Button variant="ghost" icon="x" on:click={() => set(r.id, { rejecting: true })}>{$t('adminPeople.approvals.reject')}</Button>{/if}
          </div>
          {#if d.rejecting}
            <form class="rej" on:submit|preventDefault={() => reject(r)}>
              <Field label={$t('adminPeople.approvals.message')} value={d.message} maxlength={300} hint={$t('adminPeople.approvals.messageHint')} on:input={(e) => set(r.id, { message: val(e) })} />
              <div class="acts">
                <Button type="submit" variant="danger" icon="x">{$t('adminPeople.approvals.rejectFor', { name: r.name })}</Button>
                <Button variant="ghost" on:click={() => set(r.id, { rejecting: false })}>{$t('adminPeople.approvals.cancel')}</Button>
              </div>
            </form>
          {/if}
        </section>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .intro { margin: 0 0 .9rem; color: var(--mut); font-size: .9rem; }
  .list { display: flex; flex-direction: column; gap: .7rem; }
  .req { display: flex; flex-direction: column; gap: .8rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: .9rem 1rem; min-width: 0; }
  h3 { margin: 0; font-size: 1.02rem; overflow-wrap: anywhere; }
  .sub { margin: .15rem 0 0; color: var(--mut); font-size: .88rem; overflow-wrap: anywhere; }
  .choose { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap: .7rem; max-width: 40rem; }
  .acts { display: flex; flex-wrap: wrap; gap: .5rem; }
  .rej { display: flex; flex-direction: column; gap: .6rem; max-width: 30rem; }
  .state { margin: 0; padding: 2rem 1rem; text-align: center; color: var(--mut); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .state.err { display: flex; flex-direction: column; align-items: center; gap: .6rem; color: var(--fg); }
  .state.err p { margin: 0; }
</style>
