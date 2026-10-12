<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import { t, tr } from '#lib/i18n';
  import { roleName, type RoleInfo } from '#lib/roles';
  let users: any[] = [], roles: Record<string, RoleInfo> = {};
  const load = async () => { users = (await api('/api/admin/users')).users; roles = (await api('/api/admin/roles')).roles; };
  onMount(load);
  async function kick(id: string) { const r = await api(`/api/admin/users/${id}/revoke-sessions`, { method: 'POST' }); alert(tr('admin.users.sessionsEnded', { n: r.revoked })); }
  async function patch(id: string, body: object) { try { await api(`/api/admin/users/${id}`, { method: 'PATCH', body }); } catch { alert(tr('admin.users.actionFailed')); } load(); }
</script>
<table>
  <thead><tr><th>{$t('admin.users.name')}</th><th>{$t('admin.users.email')}</th><th>{$t('admin.users.role')}</th><th>{$t('admin.users.jellyfin')}</th><th>{$t('admin.users.status')}</th><th></th></tr></thead>
  <tbody>
    {#each users as u}
      <tr>
        <td>{u.name}</td><td class="muted">{u.email ?? ''}</td>
        <td><select value={u.role} on:change={(e) => patch(u.id, { role: e.currentTarget.value })}>{#each Object.entries(roles) as [k, r]}<option value={k}>{roleName(k, r)}</option>{/each}</select></td>
        <td class="muted">{u.jellyfin_username}</td>
        <td>{#if u.disabled}<span class="err">{$t('admin.users.disabled')}</span>{:else}<span class="ok">{$t('admin.users.active')}</span>{/if}</td>
        <td class="flex"><button class="sec" on:click={() => patch(u.id, { disabled: !u.disabled })}>{u.disabled ? $t('admin.users.unlock') : $t('admin.users.lock')}</button><button class="sec" on:click={() => kick(u.id)}>{$t('admin.users.logout')}</button></td>
      </tr>
    {/each}
  </tbody>
</table>
