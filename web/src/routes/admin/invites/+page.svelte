<script lang="ts">
  import { t, fmtDateTime } from '#lib/i18n';
  import { roleName as nameOf, type RoleInfo } from '#lib/roles';
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  let invites: any[] = [], role = 'friend', ttl = 48, note = '', existing = false, created: { link: string; authentik?: 'off' | 'skipped' | 'ok' | 'failed' } | null = null;
  let roles: Record<string, RoleInfo> = {};
  const load = async () => (invites = (await api('/api/admin/invites')).invites);
  onMount(() => { void load(); api('/api/admin/roles').then((r) => (roles = r.roles)).catch(() => undefined); });
  async function create() { created = await api('/api/admin/invites', { method: 'POST', body: { role, ttlHours: ttl, note: note || undefined, enroll: !existing } }); note = ''; load(); }
  async function revoke(id: string) { await api(`/api/admin/invites/${id}`, { method: 'DELETE' }); load(); }
  /** role name in the UI language; labels renamed via ROLES_JSON stay as configured */
  $: roleName = (role: string) => nameOf(role, roles[role]);
</script>
<div class="panel flex">
  <select bind:value={role} aria-label={$t('admin.invites.role')}>{#each ['friend', 'family', 'guest'] as r}<option value={r}>{roleName(r)}</option>{/each}</select>
  <label>{$t('admin.invites.valid')} <input type="number" min="1" max="336" bind:value={ttl} style="width:5rem" /> {$t('admin.invites.hours')}</label>
  <input placeholder={$t('admin.invites.notePlaceholder')} bind:value={note} />
  <label><input type="checkbox" bind:checked={existing} /> {$t('admin.invites.hasAccount')}</label>
  <button on:click={create}>{$t('admin.invites.create')}</button>
</div>
{#if created}<div class="panel"><b>{$t('admin.invites.oneTimeLink')}</b><br /><input readonly value={created.link} style="width:100%" on:focus={(e) => e.currentTarget.select()} />
  {#if created.authentik === 'ok'}<p class="ok">{$t('admin.invites.authOk')}</p>
  {:else if created.authentik === 'failed'}<p class="warn">{$t('admin.invites.authFailed')}</p>
  {:else if created.authentik === 'off'}<p class="muted">{$t('admin.invites.authOff')}</p>{/if}
</div>{/if}
<table>
  <thead><tr><th>{$t('admin.invites.role')}</th><th>{$t('admin.invites.note')}</th><th>{$t('admin.invites.validUntil')}</th><th>{$t('admin.invites.status')}</th><th></th></tr></thead>
  <tbody>
    {#each invites as i}
      <tr><td>{roleName(i.role)}</td><td>{i.note ?? ''}</td><td>{fmtDateTime(i.expires_at)}</td>
        <td>{#if i.used_at}<span class="ok">{$t('admin.invites.usedBy', { name: i.used_by_name ?? '?' })}</span>{:else if new Date(i.expires_at) < new Date()}<span class="muted">{$t('admin.invites.expired')}</span>{:else}<span class="warn">{$t('admin.invites.open')}</span>{/if}</td>
        <td>{#if !i.used_at}<button class="sec" on:click={() => revoke(i.id)}>{$t('admin.revoke')}</button>{/if}</td></tr>
    {/each}
  </tbody>
</table>
