<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * /me/account, sessions & devices: the own devices (GET /api/devices) with "this device" and last seen. "Sign out" ends the
   * sessions of another device and keeps its approval; "Remove" forgets the device (approved again on its next sign-in);
   * or every other session at once. Approving stays on /devices.
   */
  import { onMount } from 'svelte';
  import { api, type OwnDevice } from '#lib/api';
  import { fmtDateTime, fmtRelative, t, tr } from '#lib/i18n';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import StatusPill from '#lib/ui/StatusPill.svelte';

  let devices: OwnDevice[] | null = null, loadErr = false;
  const OTHERS = 'account:revoke-others';
  const key = (d: OwnDevice) => `account:device:${d.id}`;

  async function load() {
    try { devices = (await api<{ devices: OwnDevice[] }>('/api/devices')).devices; loadErr = false; } catch { loadErr = devices === null; }
  }
  onMount(() => { void load(); });
  // the current device first, then the most recently seen
  $: sorted = devices ? [...devices].sort((a, b) => Number(b.current) - Number(a.current) || Date.parse(b.last_seen) - Date.parse(a.last_seen)) : [];
  $: waiting = devices ? devices.filter((d) => !d.approved && !d.current).length : 0;

  let heading: HTMLElement;
  async function signOut(d: OwnDevice) {
    const name = d.label;
    const ok = await confirm({ title: tr('account.account.sessions.confirmSignOut', { name }), body: tr('account.account.sessions.confirmSignOutBody'), danger: true, confirmLabel: tr('account.account.sessions.signOut') });
    if (!ok) return;
    const r = await runAction({ key: key(d), run: () => api(`/api/devices/${encodeURIComponent(d.id)}/sign-out`, { method: 'POST' }), success: tr('account.account.sessions.signedOut', { name }) });
    if (r.ok) await load(); // the device stays listed (still approved)
  }
  async function remove(d: OwnDevice) {
    const name = d.label;
    const ok = await confirm({ title: tr('account.account.sessions.confirmRemove', { name }), body: tr('account.account.sessions.confirmRemoveBody'), danger: true, confirmLabel: tr('account.account.sessions.remove') });
    if (!ok) return;
    const r = await runAction({ key: key(d), run: () => api(`/api/devices/${encodeURIComponent(d.id)}`, { method: 'DELETE' }), success: tr('account.account.sessions.removed', { name }) });
    if (r.ok) { await load(); heading?.focus(); } // the row and its focused button are gone
  }
  async function signOutOthers() {
    const ok = await confirm({ title: tr('account.account.sessions.confirmOthers'), body: tr('account.account.sessions.confirmOthersBody'), danger: true, confirmLabel: tr('account.account.sessions.signOut') });
    if (!ok) return;
    const r = await runAction({ key: OTHERS, run: () => api<{ revoked: number }>('/api/sessions/revoke-others', { method: 'POST' }), success: (res) => tr('account.devices.revoked', { n: Number(res?.revoked ?? 0) }) });
    if (r.ok) await load();
  }
</script>

<section class="panel card" aria-labelledby="acc-sessions">
  <h2 id="acc-sessions" tabindex="-1" bind:this={heading}>{$t('account.account.sessions.title')}</h2>
  {#if waiting}
    <p class="wait"><StatusPill tone="warn" label={$t('account.account.sessions.waiting', { n: waiting })} /> <a href="/devices">{$t('account.account.sessions.approveLink')}</a></p>
  {/if}
  {#if loadErr}<p class="err" role="alert">{$t('account.account.sessions.loadFailed')}</p>
  {:else if devices === null}<div class="skeleton sk" aria-hidden="true"></div>
  {:else}
    <ul class="devs">
      {#each sorted as d (d.id)}
        <li>
          <div class="info">
            <span class="name">{d.label}</span>
            {#if d.current}<StatusPill tone="info" icon="check" label={$t('account.account.sessions.thisDevice')} />
            {:else if !d.approved}<StatusPill tone="warn" label={$t('account.account.sessions.pending')} />{/if}
            <span class="muted seen"><time datetime={d.last_seen} title={fmtDateTime(d.last_seen)}>{$t('account.account.sessions.lastSeen', { when: fmtRelative(d.last_seen) })}</time></span>
          </div>
          {#if !d.current}
            <div class="row-acts">
              <Button variant="secondary" size="sm" icon="log-out" pending={$busyKeys.has(key(d))} aria-label={$t('account.account.sessions.signOutFor', { name: d.label })} on:click={() => signOut(d)}>{$t('account.account.sessions.signOut')}</Button>
              <Button variant="ghost" size="sm" icon="x" pending={$busyKeys.has(key(d))} aria-label={$t('account.account.sessions.removeFor', { name: d.label })} on:click={() => remove(d)}>{$t('account.account.sessions.remove')}</Button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  <div class="acts"><Button variant="danger" icon="log-out" pending={$busyKeys.has(OTHERS)} on:click={signOutOthers}>{$t('account.account.sessions.signOutOthers')}</Button></div>
</section>

<style>
  .card { display: flex; flex-direction: column; gap: 1rem; margin: 0; min-width: 0; }
  h2 { font-size: 1.15rem; margin: 0; }
  h2:focus { outline: none; }
  h2:focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; }
  .wait { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .8rem; }
  .wait a { display: inline-flex; align-items: center; min-height: 44px; color: #54b9c5; font-weight: 600; }
  .wait a:hover { text-decoration: underline; }
  .devs { list-style: none; margin: 0; padding: 0; }
  .devs li { display: flex; align-items: center; gap: .8rem; padding: .7rem 0; border-top: 1px solid var(--line); }
  .devs li:first-child { border-top: 0; padding-top: 0; }
  .info { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: .3rem .6rem; }
  .name { font-weight: 600; overflow-wrap: anywhere; }
  .seen { flex-basis: 100%; font-size: .88rem; }
  .row-acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .5rem; }
  .sk { height: 96px; border-radius: 8px; }
  .acts { display: flex; }
  @media (max-width: 600px) { .acts :global(button) { width: 100%; } .devs :global(button) { min-height: 44px; } .devs li { flex-wrap: wrap; } .row-acts { width: 100%; justify-content: flex-start; } }
</style>
