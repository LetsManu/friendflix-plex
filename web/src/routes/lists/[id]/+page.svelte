<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { pageStore } from '#lib/page';
  import { goto } from '$app/navigation';
  import { api } from '#lib/api';
  import Card from '#lib/Card.svelte';
  import { autofocus } from '#lib/actions';
  import { COVER_COLORS, coverGradient, isNotFound, loadList, pinThemed, removeFromList, removeMember, saveLook, setMember, type ListDetail } from '#lib/lists';
  import { kidsMode } from '#lib/kids';
  import { t, tr, hasKey, type TKey } from '#lib/i18n';
  import { confirm } from '#lib/ui/confirm';

  const page = pageStore();
  $: id = $page.params.id!;
  let data: ListDetail | null = null, missing = false, loadFailed = false, err = '', unfeatured = false;
  let editing = false, name = '', desc = '', renameBtn: HTMLButtonElement | undefined;
  let themed = false, emoji = '', color = '', isAdmin = false;
  let friends: Array<{ id: string; name: string }> = [], friendsLoaded = false, pick = '', pickRole: 'editor' | 'viewer' = 'viewer';
  /** keys of running mutations (`save`, `invite`, `del`, `rm:<item>`, `role:<user>`, `mem:<user>`): their buttons are disabled meanwhile */
  let busy = new Set<string>();
  const isBusy = (k: string) => busy.has(k);
  const setBusy = (k: string, on: boolean) => { if (on) busy.add(k); else busy.delete(k); busy = busy; };

  /** Only a 404 means the list is gone; other failures keep what is on screen (or offer a retry on first load). */
  async function load() {
    try { data = await loadList(id); missing = false; loadFailed = false; }
    catch (e) {
      if (isNotFound(e)) missing = true;
      else if (data) err = err || tr('social.lists.updateFailed');
      else loadFailed = true;
    }
  }
  async function retry() { loadFailed = false; data = null; await load(); }
  /** refresh after the list was changed through a card's list picker */
  const refresh = (e: CustomEvent<{ listId: string }>) => { if (e.detail.listId === id) void load(); };
  onMount(() => { void load(); api('/api/me').then((r) => { me = r.id ?? ''; isAdmin = Boolean(r.isAdmin && r.profile?.isOwner); }).catch(() => undefined); });
  $: owner = data?.list.role === 'owner';
  $: member = data?.list.role === 'owner' || data?.list.role === 'editor' || data?.list.role === 'viewer'; // anything else (guest of a featured list) is read-only
  $: canEdit = data?.list.role === 'owner' || data?.list.role === 'editor';
  $: candidates = friends.filter((f) => !data?.members.some((m) => m.id === f.id));
  $: if (owner && !friendsLoaded) { friendsLoaded = true; api('/api/friends').then((r) => (friends = r.friends)).catch(() => (friendsLoaded = false)); }

  const errText = (e: any) => e?.body?.error === 'too_many_featured' ? tr('mine.themed.tooManyPinned') : e?.body?.error === 'too_many_members' ? tr('social.lists.tooManyMembers') : e?.body?.error === 'bad_member' ? tr('social.lists.badMember') : tr('common.failed');
  /** role name for a list role ('owner', 'editor' …); unknown roles are shown as they are */
  const roleName = (role: string | undefined, fallback: string) => (role && hasKey(`social.lists.roles.${role}`) ? $t(`social.lists.roles.${role}` as TKey) : fallback);
  /** runs a mutation, then always re-syncs with the server (also after a failure); resolves true when the mutation succeeded */
  async function run(key: string, fn: () => Promise<unknown>): Promise<boolean> {
    if (isBusy(key)) return false;
    err = ''; setBusy(key, true);
    let ok = true;
    try { await fn(); } catch (e: any) { ok = false; err = errText(e); }
    finally { await load(); setBusy(key, false); }
    return ok;
  }
  const remove = (itemId: string) => run('rm:' + itemId, () => removeFromList(id, itemId));
  const invite = () => pick && run('invite', async () => { await setMember(id, pick, pickRole); pick = ''; });
  async function changeRole(e: Event & { currentTarget: HTMLSelectElement }, m: { id: string; role: string }) {
    const sel = e.currentTarget, value = sel.value as 'editor' | 'viewer';
    if (!(await run('role:' + m.id, () => setMember(id, m.id, value)))) sel.value = m.role; // the select must not keep a role the server refused
  }
  async function save() {
    if (!name.trim()) return;
    if (await run('save', async () => {
      await api(`/api/lists/${id}`, { method: 'PATCH', body: { name: name.trim(), description: desc.trim() || null } });
      const r = await saveLook(id, { themed, emoji: themed ? emoji.trim() || null : null, coverColor: themed ? color || null : null });
      unfeatured = Boolean(r?.unfeatured); // changing the kind of a featured list takes it off the home page until an admin re-features it
    })) await closeEdit();
  }
  function startEdit() { name = data!.list.name; desc = data!.list.description ?? ''; themed = Boolean(data!.list.themed); emoji = data!.list.emoji ?? ''; color = data!.list.coverColor ?? ''; err = ''; editing = true; }
  /** admin: pin / unpin a themed list on everybody's home page */
  const togglePin = () => run('pin', () => pinThemed(id, !data!.list.pinned));
  async function closeEdit() { editing = false; err = ''; await tick(); renameBtn?.focus(); }
  async function del() {
    if (isBusy('del') || !(await confirm({ title: tr('social.lists.confirmDelete', { name: data!.list.name }), danger: true, confirmLabel: tr('social.lists.delete') }))) return;
    err = ''; setBusy('del', true);
    try { await api(`/api/lists/${id}`, { method: 'DELETE' }); await goto('/lists'); } catch { err = tr('common.failed'); }
    setBusy('del', false);
  }
  async function leave(userId: string) {
    if (isBusy('mem:' + userId) || !(await confirm({ title: userId === me ? tr('social.lists.confirmLeave') : tr('social.lists.confirmRemoveMember'), danger: true, confirmLabel: userId === me ? tr('social.lists.leave') : tr('social.remove') }))) return;
    err = ''; setBusy('mem:' + userId, true);
    try { await removeMember(id, userId); if (userId === me) await goto('/lists'); else await load(); } catch { err = tr('common.failed'); }
    setBusy('mem:' + userId, false);
  }
  let me = '';
</script>

<svelte:head><title>{$t('common.pageTitle', { page: data?.list.name ?? $t('social.lists.fallbackTitle') })}</title></svelte:head>
{#if missing}
  <h1>{$t('social.lists.notFound')}</h1><a class="btn" href="/lists">{$t('social.lists.toLists')}</a>
{:else if loadFailed}
  <h1>{$t('social.lists.loadFailedTitle')}</h1>
  <p class="err" role="alert">{$t('social.lists.unreachable')}</p>
  <button type="button" on:click={retry}>{$t('social.tryAgain')}</button> <a class="btn sec" href="/lists">{$t('social.lists.toLists')}</a>
{:else if !data}
  <div class="tiles">{#each Array(6) as _}<div class="skeleton" style="aspect-ratio:16/9"></div>{/each}</div>
{:else}
  <div class="head">
    <div class:grow={data.list.themed && !editing}>
      {#if editing}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <form on:submit|preventDefault={save} on:keydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); void closeEdit(); } }}>
          <input type="text" maxlength="60" aria-label={$t('social.lists.nameAria')} bind:value={name} use:autofocus />
          <input type="text" maxlength="280" aria-label={$t('social.lists.description')} placeholder={$t('social.lists.descriptionPlaceholder')} bind:value={desc} />
          <label class="themedchk"><input type="checkbox" bind:checked={themed} />{$t('mine.themed.mark')}</label>
          {#if themed}
            <div class="look">
              <input type="text" class="emo-in" maxlength="8" aria-label={$t('mine.themed.emoji')} placeholder={$t('mine.themed.emojiPlaceholder')} bind:value={emoji} />
              <div class="swatches" role="radiogroup" aria-label={$t('mine.themed.color')}>
                {#each COVER_COLORS as c (c)}<button type="button" class="sw" class:on={color === c} role="radio" aria-checked={color === c} aria-label={c} style:background={c} on:click={() => (color = color === c ? '' : c)}></button>{/each}
              </div>
            </div>
          {/if}
          <button type="submit" disabled={!name.trim() || isBusy('save')}>{$t('common.save')}</button>
          <button type="button" class="sec" disabled={isBusy('save')} on:click={closeEdit}>{$t('common.cancel')}</button>
        </form>
      {:else if data.list.themed}
        <!-- editorial header: cover gradient, big title with emoji, description -->
        <header class="cover" style:background={coverGradient(data.list.coverColor)}>
          <span class="eyebrow">{$t('mine.themed.eyebrow')}</span>
          <h1>{#if data.list.emoji}<span class="emo" aria-hidden="true">{data.list.emoji}</span> {/if}{data.list.name}</h1>
          {#if data.list.description}<p class="lead">{data.list.description}</p>{/if}
          <p class="meta">{$t('social.lists.itemCount', { n: data.items.length })}{#if data.list.owner}{' · '}{$t('social.by', { name: data.list.owner.name })}{/if}</p>
        </header>
      {:else}
        <h1>{data.list.name}</h1>
        {#if data.list.description}<p class="muted">{data.list.description}</p>{/if}
        <p class="muted">{roleName(data.list.role, $t('social.lists.roles.guest'))}{#if data.list.owner}{' · '}{$t('social.by', { name: data.list.owner.name })}{/if}</p>
      {/if}
    </div>
    <div class="acts">
      {#if owner && !editing}<button class="sec" bind:this={renameBtn} on:click={startEdit}>{$t('social.lists.rename')}</button><button class="sec" disabled={isBusy('del')} on:click={del}>{$t('social.lists.delete')}</button>{/if}
      {#if isAdmin && data.list.themed && !editing}<button type="button" class:sec={!data.list.pinned} aria-pressed={Boolean(data.list.pinned)} disabled={isBusy('pin')} on:click={togglePin}>{data.list.pinned ? $t('mine.themed.unpin') : $t('mine.themed.pin')}</button>{/if}
      {#if member && !owner}<button class="sec" on:click={() => leave(me)} disabled={!me || isBusy('mem:' + me)}>{$t('social.lists.leave')}</button>{/if}
    </div>
  </div>
  {#if err}<p class="err" role="alert">{err}</p>{/if}
  {#if unfeatured}<p class="muted" role="status">{$t('mine.themed.unfeatured')}</p>{/if}
  {#if isAdmin && data.list.themed && data.list.pinned}<p class="muted">{$t('mine.themed.pinnedHint')}</p>{/if}
  {#if data.hiddenCount}<p class="muted">{$t('social.lists.hidden', { n: data.hiddenCount })}</p>{/if}

  {#if !data.items.length}<p class="muted">{member ? $t('social.lists.emptyMember') : $t('social.lists.emptyGuest')}</p>
  {:else}
    <div class="tiles">
      {#each data.items as i (i.id)}
        <div class="slot">
          <Card item={{ ...i, caption: (i.addedBy ? $t('social.by', { name: i.addedBy.name }) : '') + (i.note ? (i.addedBy ? ' · ' : '') + i.note : '') || undefined }} on:listchanged={refresh} />
          {#if canEdit}<button class="sec rm" disabled={isBusy('rm:' + i.id)} on:click={() => remove(i.id)} aria-label={$t('social.lists.removeItem', { name: i.name })}>{$t('social.remove')}</button>{/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if member && !$kidsMode}<section class="members">
    <h2>{$t('social.lists.members')}</h2>
    <ul>
      {#each data.members as m (m.id)}
        <li><span>{m.name}</span><span class="badge">{roleName(m.role, m.role)}</span>
          {#if owner && m.role !== 'owner'}
            <select aria-label={$t('social.lists.roleOf', { name: m.name })} value={m.role} disabled={isBusy('role:' + m.id)} on:change={(e) => changeRole(e, m)}>
              <option value="editor">{$t('social.lists.roles.editor')}</option><option value="viewer">{$t('social.lists.roles.viewer')}</option>
            </select>
            <button class="sec" disabled={isBusy('mem:' + m.id)} on:click={() => leave(m.id)}>{$t('social.remove')}</button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if owner}
      <form class="invite" on:submit|preventDefault={invite}>
        <select aria-label={$t('social.lists.invitePerson')} bind:value={pick}><option value="">{$t('social.lists.invitePlaceholder')}</option>{#each candidates as f}<option value={f.id}>{f.name}</option>{/each}</select>
        <select aria-label={$t('social.lists.role')} bind:value={pickRole}><option value="viewer">{$t('social.lists.roles.viewer')}</option><option value="editor">{$t('social.lists.roles.editor')}</option></select>
        <button type="submit" disabled={!pick || isBusy('invite')}>{$t('social.invite')}</button>
      </form>
    {/if}
  </section>{/if}
{/if}

<style>
  .head { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; align-items: flex-start; }
  .grow { flex: 1 1 360px; min-width: 0; }
  .acts { display: flex; gap: .5rem; flex-wrap: wrap; }
  form { display: flex; gap: .5rem; flex-wrap: wrap; }
  .muted { color: var(--mut); }
  .err { color: var(--err, #e5646e); }
  .rm { margin-top: .4rem; }
  .themedchk { display: flex; align-items: center; gap: .5rem; flex-basis: 100%; }
  .look { display: flex; gap: .8rem; align-items: center; flex-wrap: wrap; flex-basis: 100%; }
  .emo-in { width: 5rem; text-align: center; font-size: 1.2rem; }
  .swatches { display: flex; gap: .45rem; flex-wrap: wrap; }
  .sw { width: 32px; height: 32px; min-height: 32px; padding: 0; border-radius: 50%; border: 2px solid transparent; }
  .sw.on { border-color: #fff; box-shadow: 0 0 0 2px var(--acc, #ff4f6d); }
  .cover { margin-bottom: 1.4rem; border-radius: var(--radius, 8px); padding: 2.2rem 1.6rem 1.6rem; min-width: min(560px, 82vw); color: #fff; }
  .cover h1 { margin: .5rem 0 .4rem; font-size: clamp(1.8rem, 3vw + 1rem, 3rem); line-height: 1.1; letter-spacing: -.01em; }
  .cover .emo { margin-right: .15em; }
  .cover .lead { margin: 0 0 .8rem; max-width: 60ch; font-size: 1.05rem; opacity: .92; }
  .cover .meta { margin: 0; font-size: .85rem; opacity: .75; }
  .eyebrow { font-size: .72rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; opacity: .85; }
  @media (max-width: 600px) { .cover { padding: 1.4rem 1.1rem 1.1rem; min-width: 0; } }
  .members { margin-top: 2rem; max-width: 640px; }
  .members ul { list-style: none; padding: 0; margin: 0 0 1rem; }
  .members li { display: flex; gap: .6rem; align-items: center; padding: .4rem 0; flex-wrap: wrap; }
  .badge { font-size: .72rem; border: 1px solid rgba(255,255,255,.4); padding: 0 .4rem; border-radius: 3px; }
</style>
