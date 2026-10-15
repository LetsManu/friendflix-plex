<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Admin → Einstellungen (spec Part I): the settings store by group, the read-only server values, env import, restart banner, live
   * tests. A save sends only the fields that changed (a shown value may be redacted). A save that needs a recent sign-in stashes the
   * change without secrets and the action (save or test, with "Save anyway") (form.ts), goes through /auth/reauth and comes back with
   * ?resume=1: the change is restored and, when nothing had to be left out, exactly that action runs once more. A resumed action that
   * still needs a sign-in shows an error instead of another round trip. An edited URL that still carries the backend's redaction
   * marker is refused before anything is sent (it would replace the real token).
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import Icon from '#lib/Icon.svelte';
  import { isReauthError, startReauth } from '#lib/account/reauth';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import { fmtList, t, tr } from '#lib/i18n';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import { toast } from '#lib/ui/toast';
  import SettingRow from '#lib/admin/settings/SettingRow.svelte';
  import {
    fieldErrors, generate, importEnv, loadSettings, PROBE_GROUPS, probeFailure, saveSettings, SOFT_PROBE_CODES, testGroup,
    type ProbeResult, type SettingGroup, type SettingsGroupView, type SettingsView, type SettingView,
  } from '#lib/admin/settings/api';
  import {
    changedValues, clearPending, errorText, keyLabel, moveHint, probeText, redactedKeys, stashPending, takePending, type Draft, type PendingAction,
  } from '#lib/admin/settings/form';

  const RESUME = '/admin/settings?resume=1';

  let view: SettingsView | null = null, loadFailed = false;
  let edits: Record<string, Draft> = {};
  /** per key: the error code of the last save */
  let errors: Record<string, string> = {};
  /** per group: the last probe answer (a refused save or a Test) */
  let probes: Partial<Record<SettingGroup, { result: ProbeResult; save: boolean }>> = {};
  /** keys moved into the settings on this visit (env still wins until it is removed) */
  let moved = new Set<string>();
  /** a generated webhook secret, shown once (in memory only) */
  let generated: Record<string, string> = {};
  let resumeNotice: 'resumed' | 'dropped' | 'failed' | null = null;
  /** the action repeated after a re-authentication runs: another reauth_required is an error, not a new round trip */
  let resuming = false;

  $: groups = (view?.groups ?? []).filter((g): g is SettingsGroupView & { id: SettingGroup } => g.id !== 'server');
  $: server = view?.groups.find((g) => g.id === 'server') ?? null;
  $: envRows = groups.flatMap((g) => g.items).filter((i) => i.source === 'env' && !moved.has(i.key));
  $: changes = Object.fromEntries(groups.map((g) => [g.id, changedValues(g.items, edits)])) as Record<SettingGroup, Record<string, unknown>>;
  $: restartKeys = view?.pendingRestart ?? [];

  async function load(): Promise<boolean> {
    loadFailed = false;
    try { view = await loadSettings(); return true; } catch { if (!view) loadFailed = true; return false; }
  }
  // read from view (not the reactive `groups`): callers run right after load() or an edit, before the next tick
  const itemsOf = (group: SettingGroup): SettingView[] => view?.groups.find((g) => g.id === group)?.items ?? [];
  const changesOf = (group: SettingGroup) => changedValues(itemsOf(group), edits);

  onMount(async () => {
    const u = new URL(location.href);
    const resume = u.searchParams.get('resume') === '1';
    if (resume) {
      u.searchParams.delete('resume');
      void goto(u.pathname + u.search + u.hash, { shallow: true, replace: true });
    }
    if (!(await load()) || !resume) return;
    // back from the sign-in: restore what could be kept; repeat exactly the interrupted action, once, when nothing had to be left out
    const p = takePending();
    if (!p) return;
    edits = { ...p.edits };
    resumeNotice = p.dropped ? 'dropped' : 'resumed';
    if (p.dropped) return;
    resuming = true;
    try {
      if (p.action === 'test') await test(p.group);
      else if (Object.keys(changesOf(p.group)).length) await save(p.group, p.force);
    } finally { resuming = false; }
  });

  function edit(key: string, d: Draft | undefined) {
    if (d === undefined) delete edits[key]; else edits[key] = d;
    edits = edits;
    if (errors[key]) { delete errors[key]; errors = errors; }
  }

  /** a refused action that needs a recent sign-in: keep the group's change (without secrets) and the action, go through the sign-in */
  function reauth(target: { action: PendingAction; group: SettingGroup; force?: boolean } | null) {
    if (resuming) {
      // the sign-in just happened and the backend still refuses: no second round trip
      clearPending();
      resumeNotice = 'failed';
      return;
    }
    if (target) stashPending(target.action, target.group, itemsOf(target.group), edits, { force: target.force });
    startReauth(target ? RESUME : '/admin/settings');
  }
  /** refuses edited URLs that still carry the redaction marker; true when something was refused */
  function refuseRedacted(group: SettingGroup): boolean {
    const keys = redactedKeys(itemsOf(group), edits);
    if (!keys.length) return false;
    errors = { ...errors, ...Object.fromEntries(keys.map((k) => [k, 'redacted'])) };
    return true;
  }

  async function save(group: SettingGroup, force = false) {
    const values = changesOf(group);
    if (!Object.keys(values).length || refuseRedacted(group)) return;
    probes = { ...probes, [group]: undefined };
    const res = await runAction({ key: `set:save:${group}`, run: () => saveSettings(values, force), success: tr('settings.saved'), error: false });
    if (res.ok) {
      for (const k of Object.keys(values)) delete edits[k];
      edits = edits;
      resumeNotice = null;
      await load();
      return;
    }
    if (isReauthError(res.error)) return reauth({ action: 'save', group, force });
    const fe = fieldErrors(res.error);
    const pf = probeFailure(res.error);
    if (fe) errors = { ...errors, ...fe };
    if (pf) probes = { ...probes, [group]: { result: pf, save: true } };
    else toast.error(tr('settings.saveFailed'));
  }

  async function test(group: SettingGroup) {
    probes = { ...probes, [group]: undefined };
    if (refuseRedacted(group)) return;
    const values = changesOf(group);
    const res = await runAction({ key: `set:test:${group}`, run: () => testGroup(group, values), error: false });
    if (res.ok && res.value) { probes = { ...probes, [group]: { result: res.value, save: false } }; return; }
    if (isReauthError(res.error)) return reauth({ action: 'test', group });
    const fe = fieldErrors(res.error);
    if (fe) errors = { ...errors, ...fe };
    toast.error(tr('settings.testFailed'));
  }

  async function move(keys: string[] | 'all') {
    const res = await runAction({
      key: keys === 'all' ? 'set:move:all' : `set:move:${keys[0]}`, run: () => importEnv(keys), error: tr('settings.moveFailed'),
      success: (r) => (r?.moved.length ? tr('settings.moved', { n: r.moved.length }) : tr('settings.movedNone')),
    });
    if (res.ok && res.value) { moved = new Set([...moved, ...res.value.moved]); await load(); }
  }

  async function regenerate(item: SettingView) {
    const what = item.generate!;
    const ok = await confirm({
      title: tr(what === 'webhookSecret' ? 'settings.generate.webhookConfirm' : 'settings.generate.vapidConfirm'),
      body: tr(what === 'webhookSecret' ? 'settings.generate.webhookBody' : 'settings.generate.vapidBody'),
      danger: true, confirmLabel: tr(`settings.generate.${what}`),
    });
    if (!ok) return;
    const res = await runAction({
      key: `set:gen:${item.key}`, run: (): Promise<{ secret: string } | { publicKey: string }> => (what === 'webhookSecret' ? generate('webhookSecret') : generate('vapidPair')),
      success: what === 'webhookSecret' ? undefined : tr('settings.generate.done'), error: false,
    });
    if (res.ok && res.value) {
      if ('secret' in res.value) generated = { ...generated, [item.key]: res.value.secret };
      await load();
      return;
    }
    if (isReauthError(res.error)) return reauth(null);
    toast.error(tr('settings.generate.failed'));
  }
</script>

<div class="wrap">
  <p class="intro muted">{$t('settings.intro')}</p>
  {#if loadFailed}
    <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('settings.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div>
  {:else if !view}
    <AdminCard><div class="sk" aria-hidden="true"><Skeleton w="12rem" h="2rem" /><Skeleton h="2.8rem" /><Skeleton h="2.8rem" /></div><p class="sr-only" role="status">{$t('ui.table.loading')}</p></AdminCard>
  {:else}
    {#if resumeNotice === 'dropped'}<p class="banner warn" role="alert"><Icon name="key" size={18} />{$t('settings.reauth.dropped')}</p>
    {:else if resumeNotice === 'failed'}<p class="banner warn" role="alert"><Icon name="alert" size={18} />{$t('settings.reauth.failed')}</p>
    {:else if resumeNotice === 'resumed'}<p class="banner" role="status"><Icon name="check" size={18} />{$t('settings.reauth.resumed')}</p>{/if}
    {#if restartKeys.length}
      <div class="banner warn" role="status">
        <Icon name="refresh" size={18} />
        <div>
          <p>{$t('settings.restartBanner', { keys: fmtList(restartKeys.map(keyLabel)) })}</p>
          <p>{$t('settings.restartCommand')} <code>docker compose restart backend</code></p>
        </div>
      </div>
    {/if}
    {#if envRows.length}
      <div class="banner">
        <Icon name="lock" size={18} />
        <p>{$t('settings.moveAllHint', { n: envRows.length })}</p>
        <Button variant="secondary" size="sm" icon="download" pending={$busyKeys.has('set:move:all')} on:click={() => move('all')}>{$t('settings.moveAll')}</Button>
      </div>
    {/if}

    {#each groups as g (g.id)}
      {@const dirty = Object.keys(changes[g.id] ?? {}).length > 0}
      {@const probe = probes[g.id]}
      <AdminCard title={$t(`settings.groups.${g.id}`)}>
        <svelte:fragment slot="actions">
          {#if PROBE_GROUPS.has(g.id)}
            <Button variant="secondary" size="sm" icon="activity" pending={$busyKeys.has(`set:test:${g.id}`)} on:click={() => test(g.id)}>{$t('settings.test')}</Button>
          {/if}
        </svelte:fragment>
        <form novalidate on:submit|preventDefault={() => save(g.id)}>
          {#each g.items as item (item.key)}
            <SettingRow {item} draft={edits[item.key]} error={errors[item.key] ? errorText(errors[item.key]) : ''}
              movedHint={moved.has(item.key) ? moveHint(item.envNames) : ''} moving={$busyKeys.has(`set:move:${item.key}`)}
              generating={$busyKeys.has(`set:gen:${item.key}`)} generated={generated[item.key] ?? ''}
              on:edit={(e) => edit(item.key, e.detail)} on:move={() => move([item.key])} on:generate={() => regenerate(item)} />
          {/each}
          {#if probe}
            {#if probe.result.ok}
              <p class="probe ok" role="status">{probeText(probe.result)}</p>
            {:else}
              <div class="probe err" role="alert">
                <p>{probe.save ? $t('settings.probeFailed', { reason: probeText(probe.result) }) : probeText(probe.result)}</p>
                {#if probe.save && SOFT_PROBE_CODES.has(probe.result.code)}
                  <p class="muted">{$t('settings.probeSoft')}</p>
                  <Button variant="secondary" size="sm" pending={$busyKeys.has(`set:save:${g.id}`)} on:click={() => save(g.id, true)}>{$t('settings.saveAnyway')}</Button>
                {/if}
              </div>
            {/if}
          {/if}
          <div class="foot">
            {#if dirty}<StatusPill tone="warn" icon="clock" label={$t('settings.unsaved')} />{/if}
            <Button type="submit" icon="check" pending={$busyKeys.has(`set:save:${g.id}`)} disabled={!dirty}>{$t('settings.save')}</Button>
          </div>
        </form>
      </AdminCard>
    {/each}

    {#if server}
      <AdminCard title={$t('settings.groups.server')} description={$t('settings.serverHelp')}>
        <dl class="server">
          {#each server.items as s (s.key)}
            <div>
              <dt><code>{s.key}</code></dt>
              <dd>
                <StatusPill tone={s.source === 'env' || s.source === 'bootstrap' ? 'info' : 'muted'} label={$t(`settings.source.${s.source}`)} />
                {#if s.kind !== 'secret' && s.value !== null && s.value !== undefined}<code class="val">{String(s.value)}</code>
                {:else if s.kind === 'secret'}<span class="muted small">{s.set ? $t('settings.secret.set') : $t('settings.secret.unset')}</span>{/if}
              </dd>
            </div>
          {/each}
        </dl>
      </AdminCard>
    {/if}
  {/if}
</div>

<style>
  .wrap { max-width: 760px; }
  .intro { margin: 0 0 1rem; }
  form { display: grid; gap: .25rem; }
  .foot { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: .6rem; padding-top: .8rem; border-top: 1px solid var(--line); }
  .banner { display: flex; align-items: center; flex-wrap: wrap; gap: .6rem .8rem; margin: 0 0 1rem; padding: .75rem .9rem; border-radius: 8px; background: var(--tone-info); border: 1px solid var(--line); }
  .banner.warn { background: var(--tone-warn); }
  .banner p { margin: 0; flex: 1 1 14rem; min-width: 0; }
  .banner > div { flex: 1 1 14rem; display: grid; gap: .3rem; min-width: 0; }
  .banner :global(svg) { flex: none; }
  code { overflow-wrap: anywhere; }
  .probe { margin: .4rem 0 0; padding: .6rem .8rem; border-radius: 6px; display: grid; gap: .4rem; justify-items: start; }
  .probe p { margin: 0; }
  .probe.ok { background: var(--tone-ok); color: var(--ok); }
  .probe.err { background: var(--tone-err); color: var(--fg); }
  .server { margin: 0; display: grid; gap: .5rem; }
  .server div { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .3rem .8rem; padding: .35rem 0; border-top: 1px solid var(--line); }
  .server div:first-child { border-top: 0; }
  .server dt, .server dd { margin: 0; min-width: 0; }
  .server dd { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
  .val { font-size: .85rem; color: var(--mut); }
  .small { font-size: .85rem; }
  .sk { display: grid; gap: 1rem; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .state p { margin: 0; } .state :global(svg) { color: var(--err); }
</style>
