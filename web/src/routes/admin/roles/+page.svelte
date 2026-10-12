<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '#lib/api';
  import { t, tr } from '#lib/i18n';
  import { roleName as nameOf } from '#lib/roles';
  type Row = { role: string; label: string; builtinLabel?: boolean; requestsPerMonth: number | null; isDefault: boolean; value: number; unlimited: boolean; transcoding: boolean; maxHeight: number | null; download?: boolean; maxDownloads?: number | null; downloadMaxHeight?: number | null; downloadDays?: number | null };
  const HEIGHTS = [720, 1080, 1440, 2160];
  const DL_HEIGHTS = [480, 720, 1080];
  let rows: Row[] = [];
  const load = async () => (rows = (await api('/api/admin/roles')).limits.map((r: any) => ({ ...r, value: r.requestsPerMonth ?? 2, unlimited: r.requestsPerMonth === null })));
  onMount(load);
  async function save(r: Row) {
    const v = Math.round(Number(r.value));
    if (!r.unlimited && !(v >= 0 && v <= 100)) return alert(tr('admin.roles.numberRange'));
    const md = Math.round(Number(r.maxDownloads ?? 0)), dd = Math.round(Number(r.downloadDays ?? 30));
    if (!(md >= 0 && md <= 200)) return alert(tr('admin.roles.downloadsRange'));
    if (!(dd >= 1 && dd <= 90)) return alert(tr('admin.roles.daysRange'));
    try { await api(`/api/admin/roles/${encodeURIComponent(r.role)}`, { method: 'PUT', body: { requestsPerMonth: r.unlimited ? null : v, transcoding: r.transcoding, maxHeight: r.maxHeight, download: Boolean(r.download), maxDownloads: Math.round(Number(r.maxDownloads ?? 0)), downloadMaxHeight: r.downloadMaxHeight, downloadDays: Math.round(Number(r.downloadDays ?? 30)) } }); } catch { alert(tr('admin.roles.saveFailed')); }
    load();
  }
  /** role name in the UI language; labels renamed via ROLES_JSON stay as configured */
  const roleName = (r: Row) => nameOf(r.role, r);
</script>
<p class="muted">{$t('admin.roles.intro')}</p>
<table>
  <thead><tr><th>{$t('admin.roles.role')}</th><th>{$t('admin.roles.perMonth')}</th><th>{$t('admin.roles.playback')}</th><th>{$t('admin.roles.downloads')}</th><th></th></tr></thead>
  <tbody>
    {#each rows as r (r.role)}
      <tr>
        <td>{roleName(r)} <span class="muted">({r.role})</span></td>
        <td class="flex">
          <input type="number" min="0" max="100" aria-label={$t('admin.roles.perMonth')} bind:value={r.value} disabled={r.unlimited} style="width:6rem" />
          <label><input type="checkbox" bind:checked={r.unlimited} /> {$t('admin.roles.unlimited')}</label>
          {#if r.isDefault}<span class="muted">{$t('common.standard')}</span>{/if}
        </td>
        <td class="flex">
          <label><input type="checkbox" bind:checked={r.transcoding} /> {$t('admin.roles.transcoding')}</label>
          <label>{$t('admin.roles.maxHeight')}
            <select bind:value={r.maxHeight} aria-label={$t('admin.roles.maxHeight')}>
              {#each HEIGHTS as h}<option value={h}>{h}p</option>{/each}
              <option value={null}>{$t('admin.roles.unlimitedLower')}</option>
            </select>
          </label>
        </td>
        <td class="flex">
          <label><input type="checkbox" bind:checked={r.download} /> {$t('admin.roles.allowDownloads')}</label>
          <label>{$t('admin.roles.maxDownloads')}
            <input type="number" min="0" max="200" bind:value={r.maxDownloads} disabled={!r.download} aria-label={$t('admin.roles.maxDownloads')} style="width:5rem" />
          </label>
          <label>{$t('admin.roles.downloadQuality')}
            <select bind:value={r.downloadMaxHeight} disabled={!r.download} aria-label={$t('admin.roles.downloadQuality')}>
              {#each DL_HEIGHTS as h}<option value={h}>{h}p</option>{/each}
              <option value={null}>{$t('admin.roles.likePlayback')}</option>
            </select>
          </label>
          <label>{$t('admin.roles.validity')}
            <input type="number" min="1" max="90" bind:value={r.downloadDays} disabled={!r.download} aria-label={$t('admin.roles.validity')} style="width:5rem" />
          </label>
        </td>
        <td><button on:click={() => save(r)}>{$t('common.save')}</button></td>
      </tr>
    {/each}
  </tbody>
</table>
