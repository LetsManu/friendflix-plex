<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin: one user. Header (avatar, name, e-mail, role, status and 2FA pills) with the quick actions (lock/unlock, sign out
   * everywhere, change role, extend access, Authentik e-mails; a scheduled deletion: restore or delete now), then tabs in the URL (`?tab=`): overview (totals, linked
   * accounts), profiles, devices, downloads, activity (loads only when opened: viewing is audited), limits, audit.
   * Never shows credentials, tokens or the Authentik id (the API does not send them).
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, ApiError } from '#lib/api';
  import { avatarBg, initial } from '#lib/avatars';
  import { fmtDate, fmtRelative, locale, t, tr } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import MoreActions, { type MoreAction } from '#lib/MoreActions.svelte';
  import { pageStore } from '#lib/page';
  import { accessPreset, accountGuardText, deletionErrorText, futureDayEnd, restoredText, today } from '#lib/admin/people';
  import { refreshSummary } from '#lib/admin/summary';
  import { DETAIL_TABS, akError, detailTab, lockAction, mfaChips, statusPills, type DetailTab, type UserDetail } from '#lib/admin/user/detail';
  import Activity from '#lib/admin/user/Activity.svelte';
  import Audit from '#lib/admin/user/Audit.svelte';
  import Devices from '#lib/admin/user/Devices.svelte';
  import Downloads from '#lib/admin/user/Downloads.svelte';
  import Limits from '#lib/admin/user/Limits.svelte';
  import Overview from '#lib/admin/user/Overview.svelte';
  import Profiles from '#lib/admin/user/Profiles.svelte';
  import { roleName, type RoleInfo } from '#lib/roles';
  import { busyKeys, errorText, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import Field from '#lib/ui/Field.svelte';
  import Select from '#lib/ui/Select.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import { toast } from '#lib/ui/toast';

  const page$ = pageStore();
  $: id = $page$.params.id ?? '';
  $: tab = detailTab($page$.url.searchParams.get('tab'));
  const select = (to: DetailTab) => goto(to === 'overview' ? $page$.url.pathname : `?tab=${to}`, { replaceState: true, reset: false });
  function tabKey(e: KeyboardEvent) {
    const i = DETAIL_TABS.indexOf(tab), last = DETAIL_TABS.length - 1;
    const n = e.key === 'ArrowRight' ? (i + 1) % DETAIL_TABS.length : e.key === 'ArrowLeft' ? (i + last) % DETAIL_TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (n < 0) return;
    e.preventDefault(); void select(DETAIL_TABS[n]!);
    queueMicrotask(() => { const el = document.getElementById(`udt-${DETAIL_TABS[n]!}`); el?.focus(); el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
  }

  let d: UserDetail | null = null, error: string | null = null, notFound = false;
  let roles: Record<string, RoleInfo> = {}, meId = '';
  let seq = 0, loadedId = '';
  /** reload keeps the shown data until the answer is there (open tabs stay mounted) */
  async function load() {
    const my = ++seq;
    try {
      const r = await api<UserDetail>(`/api/admin/users/${id}`);
      if (my === seq) { d = r; error = null; notFound = false; }
    } catch (e) {
      if (my !== seq) return;
      notFound = e instanceof ApiError && (e.status === 404 || e.status === 400);
      error = notFound ? tr('adminPeople.detail.notFound') : tr('adminPeople.loadFailed');
      // a failed reload after an action: the shown data may be stale, say so
      if (d) toast.error(error);
    }
  }
  $: if (id && id !== loadedId) { loadedId = id; d = null; error = null; panel = null; void load(); }
  onMount(() => {
    api<{ roles: Record<string, RoleInfo> }>('/api/admin/roles').then((r) => (roles = r.roles), () => undefined);
    api<{ id: string }>('/api/me').then((m) => (meId = m.id), () => undefined);
  });

  $: rname = (k: string): string => roleName(k, roles[k]);
  $: u = d?.user ?? null;
  $: self = u !== null && u.id === meId;
  $: busy = $busyKeys.has(`user:${id}`);
  // the pill texts come from tr(): $locale makes them follow an in-place language switch
  $: pills = u && $locale ? statusPills(u) : [];
  $: chips = d && $locale ? mfaChips(d.mfa) : [];

  // ---- quick actions ----
  const patch = (body: Record<string, unknown>) => () => api(`/api/admin/users/${id}`, { method: 'PATCH', body });
  const guardError = (e: unknown): string => accountGuardText(e) ?? errorText(e);
  async function setLocked(disabled: boolean) {
    if (!u) return;
    const name = u.name;
    if (disabled) {
      const ok = await confirm({
        title: tr('adminPeople.users.confirmLockTitle', { name }), body: tr('adminPeople.users.confirmLockBody', { name }),
        danger: true, confirmLabel: tr('adminPeople.users.lock'), ...(u.role === 'admin' ? { typed: name } : {}),
      });
      if (!ok) return;
    }
    const r = await runAction({
      key: `user:${id}`, run: patch({ disabled }), error: guardError,
      success: tr(disabled ? 'adminPeople.users.lockedToast' : 'adminPeople.users.unlockedToast', { name }),
    });
    if (r.ok) { void load(); void refreshSummary(); }
  }
  async function signOut() {
    if (!u) return;
    const name = u.name;
    const ok = await confirm({ title: tr('adminPeople.users.confirmSignOutTitle', { name }), body: tr('adminPeople.users.confirmSignOutBody', { name }), danger: true, confirmLabel: tr('adminPeople.users.signOut') });
    if (!ok) return;
    const r = await runAction({
      key: `user:${id}`, run: () => api<{ revoked: number }>(`/api/admin/users/${id}/revoke-sessions`, { method: 'POST' }),
      success: (res) => tr('adminPeople.users.signedOutToast', { name, n: res?.revoked ?? 0 }),
    });
    if (r.ok) void load();
  }
  // a scheduled deletion (Block 23 self-service): restore cancels it, delete now hands it to the next deletion tick
  async function restoreDeletion() {
    if (!u) return;
    const r = await runAction({
      key: `user:${id}`, run: () => api(`/api/admin/users/${id}/deletion/restore`, { method: 'POST' }), error: deletionErrorText,
      success: restoredText(u.name, u.accessUntil),
    });
    if (r.ok) { void load(); void refreshSummary(); }
  }
  async function deleteNow() {
    if (!u) return;
    const name = u.name;
    const ok = await confirm({
      title: tr('adminPeople.detail.actions.deleteNowTitle', { name }), body: tr('adminPeople.detail.actions.deleteNowBody', { name }),
      danger: true, confirmLabel: tr('adminPeople.detail.actions.deleteNow'),
    });
    if (!ok) return;
    const r = await runAction({
      key: `user:${id}`, run: () => api(`/api/admin/users/${id}/deletion/now`, { method: 'POST' }), error: deletionErrorText,
      success: tr('adminPeople.detail.actions.deleteNowDone', { name }),
    });
    if (r.ok) void load();
  }
  async function sendRecovery() {
    if (!u) return;
    const name = u.name;
    const ok = await confirm({ title: tr('adminPeople.detail.actions.recoveryTitle', { name }), body: tr('adminPeople.detail.actions.recoveryBody'), confirmLabel: tr('adminPeople.detail.actions.send') });
    if (!ok) return;
    await runAction({ key: `user:${id}`, run: () => api(`/api/admin/users/${id}/recovery`, { method: 'POST' }), success: tr('adminPeople.detail.actions.recoverySent', { name }), error: akError });
  }
  async function sendMfaSetup() {
    if (!u) return;
    const name = u.name;
    await runAction({ key: `user:${id}`, run: () => api(`/api/admin/users/${id}/mfa-setup`, { method: 'POST' }), success: tr('adminPeople.detail.actions.mfaSetupSent', { name }), error: akError });
  }

  // role / access: a small form under the header (the menu only opens it)
  let panel: 'role' | 'access' | null = null, newRole = '', access = '', accessDay = '';
  function open(p: 'role' | 'access') { panel = p; newRole = ''; access = ''; accessDay = ''; }
  $: roleOptions = [{ value: '', label: $t('adminPeople.bulk.roleChoose') }, ...Object.keys(roles).filter((k) => k !== u?.role).map((k) => ({ value: k, label: rname(k) }))];
  $: accessOptions = [
    { value: '', label: $t('adminPeople.access.choose') }, { value: 'p30', label: $t('adminPeople.access.p30') }, { value: 'p90', label: $t('adminPeople.access.p90') },
    { value: 'unlimited', label: $t('adminPeople.access.unlimited') }, { value: 'date', label: $t('adminPeople.access.date') },
  ];
  async function applyRole() {
    if (!u || !newRole) return;
    const name = u.name, role = newRole;
    if (u.role === 'admin' && role !== 'admin') {
      const ok = await confirm({
        title: tr('adminPeople.detail.actions.demoteTitle', { name }), body: tr('adminPeople.detail.actions.demoteBody', { name, role: rname(role) }),
        danger: true, confirmLabel: tr('adminPeople.detail.actions.apply'), typed: name,
      });
      if (!ok) return;
    }
    const r = await runAction({ key: `user:${id}`, run: patch({ role }), error: guardError, success: tr('adminPeople.users.roleChanged', { name, role: rname(role) }) });
    if (r.ok) { panel = null; void load(); }
  }
  // a past end date would lock the account at the next expiry tick
  $: accessReady = access !== '' && (access !== 'date' || futureDayEnd(accessDay) !== '');
  async function applyAccess() {
    if (!u || !accessReady) return;
    const name = u.name;
    const accessUntil = access === 'date' ? futureDayEnd(accessDay) : accessPreset(access === 'p30' ? '+30' : access === 'p90' ? '+90' : 'unlimited');
    const r = await runAction({
      key: `user:${id}`, run: patch({ accessUntil }),
      success: accessUntil ? tr('adminPeople.detail.actions.accessSet', { name, date: fmtDate(accessUntil, { dateStyle: 'medium' }) }) : tr('adminPeople.detail.actions.accessUnlimited', { name }),
    });
    if (r.ok) { panel = null; void load(); void refreshSummary(); }
  }

  // Authentik actions only with a reachable Authentik (mfa known) and when the backend offers them
  $: actions = ((): MoreAction[] => {
    // nothing until /api/me says whether this is the admin's own account
    if (!d || !u || meId === '') return [];
    // own account: no lock, demotion or "sign out everywhere" (it would end this very session)
    const extend: MoreAction = { id: 'access', label: $t('adminPeople.detail.actions.extend'), icon: 'calendar', run: () => open('access') };
    // access ended: "Extend access" takes the place of "Unlock" (an unlock would not last)
    const lock = lockAction(u);
    // a scheduled deletion: restore takes the place of "Unlock", plus delete now (never on yourself); nothing else applies
    if (lock === 'restore') {
      return [
        { id: 'restore', label: $t('adminPeople.detail.actions.restore'), icon: 'unlock', run: restoreDeletion },
        ...(self ? [] : [{ id: 'delete-now', label: $t('adminPeople.detail.actions.deleteNow'), icon: 'x', danger: true, run: deleteNow }]),
      ];
    }
    const out: MoreAction[] = self
      ? [{ id: 'self', label: $t('adminPeople.users.selfNote'), icon: 'lock', disabled: true }]
      : [
        lock === 'extend' ? extend
          : lock === 'unlock' ? { id: 'unlock', label: $t('adminPeople.users.unlock'), icon: 'unlock', run: () => setLocked(false) }
          : { id: 'lock', label: $t('adminPeople.users.lock'), icon: 'lock', danger: true, run: () => setLocked(true) },
        { id: 'role', label: $t('adminPeople.detail.actions.changeRole'), icon: 'key', run: () => open('role') },
        { id: 'signout', label: $t('adminPeople.users.signOut'), icon: 'log-out', danger: true, run: signOut },
      ];
    if (self || lock !== 'extend') out.push(extend);
    if (d.mfa !== null && d.authentik.recovery) out.push({ id: 'recovery', label: $t('adminPeople.detail.actions.recovery'), icon: 'mail', run: sendRecovery });
    if (d.mfa !== null && d.authentik.mfaSetup) out.push({ id: 'mfa', label: $t('adminPeople.detail.actions.mfaSetup'), icon: 'shield', run: sendMfaSetup });
    return out;
  })();
  $: tabLabel = (k: DetailTab): string => $t(`adminPeople.detail.tabs.${k}`);
</script>

<p class="back"><a href="/admin/users"><Icon name="chevron-left" size={16} />{$t('adminPeople.detail.back')}</a></p>

{#if error && !d}
  <div class="state" role="alert">
    <Icon name="alert" size={22} /><p>{error}</p>
    {#if !notFound}<Button variant="secondary" icon="refresh" on:click={() => { error = null; void load(); }}>{$t('ui.retry')}</Button>{/if}
  </div>
{:else if !d || !u}
  <div class="head" aria-busy="true"><Skeleton w="64px" h="64px" radius="50%" /><div class="who"><Skeleton w="12rem" h="1.4rem" /><Skeleton w="9rem" h=".9rem" /></div></div>
{:else}
  <section class="head" aria-labelledby="ud-name" aria-busy={busy ? 'true' : undefined}>
    <span class="av" style:background={avatarBg(u.avatar ?? undefined)} aria-hidden="true">{initial(u.name)}</span>
    <div class="who">
      <h2 id="ud-name">{u.name}</h2>
      <p class="sub">{#if u.email}<span>{u.email}</span>{/if}<span class="role"><Icon name="key" size={14} />{rname(u.role)}</span></p>
      <p class="pills">
        {#each pills as p (p.label)}<StatusPill tone={p.tone} label={p.label} icon={p.icon} />{/each}
        <span class="sr-only">{$t('adminPeople.detail.mfa.label')}:</span>
        {#each chips as c (c.label)}<StatusPill tone={c.tone} label={c.label} icon="shield" />{/each}
      </p>
      <p class="meta">
        <span>{$t('adminPeople.detail.since', { date: fmtDate(u.createdAt, { dateStyle: 'medium' }) })}</span>
        <span>{u.lastActive ? $t('adminPeople.detail.lastActive', { time: fmtRelative(u.lastActive) }) : `${$t('adminPeople.users.col.lastSeen')}: ${$t('adminPeople.never')}`}</span>
      </p>
    </div>
    <div class="acts"><MoreActions variant="pill" label={$t('adminPeople.detail.actions.label')} title={u.name} {actions} /></div>
  </section>

  {#if panel === 'role'}
    <form class="panel" aria-label={$t('adminPeople.detail.actions.changeRole')} on:submit|preventDefault={applyRole}>
      <Select label={$t('adminPeople.detail.actions.newRole')} options={roleOptions} bind:value={newRole} disabled={busy} />
      <Button type="submit" size="sm" disabled={busy || !newRole}>{$t('adminPeople.detail.actions.apply')}</Button>
      <Button variant="ghost" size="sm" on:click={() => (panel = null)}>{$t('adminPeople.detail.actions.cancel')}</Button>
    </form>
  {:else if panel === 'access'}
    <form class="panel" aria-label={$t('adminPeople.detail.actions.extend')} on:submit|preventDefault={applyAccess}>
      <Select label={$t('adminPeople.access.label')} options={accessOptions} bind:value={access} disabled={busy} />
      {#if access === 'date'}<Field type="date" label={$t('adminPeople.access.day')} bind:value={accessDay} min={today()} required />{/if}
      <Button type="submit" size="sm" disabled={busy || !accessReady}>{$t('adminPeople.detail.actions.apply')}</Button>
      <Button variant="ghost" size="sm" on:click={() => (panel = null)}>{$t('adminPeople.detail.actions.cancel')}</Button>
    </form>
  {/if}

  <div class="tabs" role="tablist" aria-label={$t('adminPeople.detail.tabs.label', { name: u.name })}>
    {#each DETAIL_TABS as k (k)}
      <button type="button" role="tab" id="udt-{k}" class="tab" class:on={tab === k} aria-selected={tab === k} aria-controls="udt-panel" tabindex={tab === k ? 0 : -1} on:click={() => select(k)} on:keydown={tabKey}>{tabLabel(k)}</button>
    {/each}
  </div>

  <div id="udt-panel" role="tabpanel" aria-labelledby="udt-{tab}" tabindex="-1">
    {#if tab === 'profiles'}<Profiles userId={u.id} profiles={d.profiles} on:changed={load} />
    {:else if tab === 'devices'}<Devices userId={u.id} devices={d.devices} on:changed={load} />
    {:else if tab === 'downloads'}<Downloads licenses={d.licenses} profiles={d.profiles} on:changed={load} />
    {:else if tab === 'activity'}{#key u.id}<Activity userId={u.id} />{/key}
    {:else if tab === 'limits'}{#key u.id}<Limits userId={u.id} />{/key}
    {:else if tab === 'audit'}{#key u.id}<Audit userId={u.id} />{/key}
    {:else}<Overview userId={u.id} detail={d} on:changed={load} />{/if}
  </div>
{/if}

<style>
  .back { margin: -.6rem 0 1rem; }
  .back a { display: inline-flex; align-items: center; gap: .3rem; min-height: 32px; color: var(--mut); font-size: .9rem; }
  .back a:hover { color: var(--fg); text-decoration: underline; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .state p { margin: 0; }
  .state :global(svg) { color: var(--err); }
  .head { display: flex; align-items: flex-start; gap: 1rem; margin-bottom: 1rem; }
  .av { width: 64px; height: 64px; flex: none; border-radius: 50%; display: grid; place-items: center; font-weight: 800; font-size: 1.6rem; color: #fff; }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .35rem; }
  h2 { margin: 0; font-size: 1.35rem; font-weight: 800; overflow-wrap: anywhere; }
  .who p { margin: 0; }
  .sub { display: flex; flex-wrap: wrap; gap: .2rem 1rem; color: var(--mut); overflow-wrap: anywhere; }
  .role { display: inline-flex; align-items: center; gap: .3rem; color: var(--fg); font-weight: 600; }
  .pills { display: flex; flex-wrap: wrap; gap: .35rem; }
  .meta { display: flex; flex-wrap: wrap; gap: .2rem 1rem; color: var(--mut); font-size: .85rem; }
  .acts { flex: none; }
  .panel { display: flex; flex-wrap: wrap; align-items: flex-end; gap: .6rem; padding: .8rem; margin-bottom: 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .panel :global(.field) { min-width: 12rem; }
  .tabs { display: flex; gap: .4rem; overflow-x: auto; scrollbar-width: none; margin-bottom: 1rem; border-bottom: 1px solid var(--line); }
  .tabs::-webkit-scrollbar { display: none; }
  .tab { flex: none; min-height: 44px; padding: 0 .9rem; background: transparent; color: var(--mut); border: 0; border-bottom: 2px solid transparent; border-radius: 0; font-weight: 600; white-space: nowrap; }
  .tab:hover:not(:disabled) { color: var(--fg); background: rgba(255,255,255,.04); }
  .tab.on { color: var(--fg); border-bottom-color: var(--accent, #fff); }
  #udt-panel:focus { outline: none; }
  @media (max-width: 600px) {
    .head { flex-wrap: wrap; }
    .av { width: 48px; height: 48px; font-size: 1.25rem; }
    .acts { width: 100%; }
    .panel :global(.field) { min-width: 0; width: 100%; }
  }
</style>
