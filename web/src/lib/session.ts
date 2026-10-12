import { api } from '#lib/api';
import { disablePush } from '#lib/push';
import { getAllDownloads } from '#lib/offline/db';
import { clearHint } from '#lib/gate';
import { tr } from '#lib/i18n';

/** Signs out: offers to wipe offline downloads, drops this device's push subscription, ends the session and leaves the app. */
export async function logout(tv: boolean | undefined) {
  let hasDl = false;
  try { hasDl = (await getAllDownloads()).length > 0; } catch { /* no IndexedDB */ }
  if (hasDl && confirm(tr('account.logout.confirmDownloads'))) await (await import('#lib/offline/manager')).removeAll().catch(() => undefined);
  await Promise.race([disablePush().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]); // best effort: drop this device's push subscription before the session ends
  // the next login (maybe another account) starts without the early-render hint and sees the profile gate again – also when the request fails
  try { await api('/auth/logout', { method: 'POST' }); } finally { clearHint(); }
  location.href = tv ? '/tv' : '/auth/login';
}
