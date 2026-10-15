<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Step 6 of the setup wizard (spec Part F): optional extras for the first admin, signed in (completeSetup stamped a fresh sign-in, so
   * secrets save without another one). Every card has Skip; Finish goes to /. The cards are Admin → Settings rows (SettingRow, the same
   * API), a card saves only its own changed keys. Push keys are generated on the server (only "set" is shown, the private key never
   * reaches the browser); the webhook secret is shown once, in memory only, with the header line to paste.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { ApiError } from '#lib/api';
  import { isReauthError, startReauth } from '#lib/account/reauth';
  import AdminCard from '#lib/adminContent/AdminCard.svelte';
  import SettingRow from '#lib/admin/settings/SettingRow.svelte';
  import { fieldErrors, generate, importEnv, loadSettings, probeFailure, saveSettings, type SettingsView, type SettingView } from '#lib/admin/settings/api';
  import { changedValues, errorText, moveHint, probeText, type Draft } from '#lib/admin/settings/form';
  import { keepPageOnSwitch, t, tr } from '#lib/i18n';
  import Icon from '#lib/Icon.svelte';
  import { busyKeys, runAction } from '#lib/ui/action';
  import Button from '#lib/ui/Button.svelte';
  import { confirm } from '#lib/ui/confirm';
  import CopyField from '#lib/ui/CopyField.svelte';
  import Skeleton from '#lib/ui/Skeleton.svelte';
  import StatusPill from '#lib/ui/StatusPill.svelte';
  import { toast } from '#lib/ui/toast';
  import Notice from '#lib/setup/Notice.svelte';

  type CardId = 'requests' | 'sources' | 'downloads' | 'push' | 'notifications' | 'webhooks' | 'updates';
  const CARDS: Array<{ id: CardId; keys: string[] }> = [
    { id: 'requests', keys: ['REQUESTS_URL', 'REQUESTS_API_KEY'] },
    { id: 'sources', keys: ['TMDB_API_KEY', 'OMDB_API_KEY'] },
    { id: 'downloads', keys: ['DOWNLOADS_ENABLED'] },
    { id: 'push', keys: [] },
    { id: 'notifications', keys: ['NTFY_URL', 'DISCORD_WEBHOOK_URL'] },
    { id: 'webhooks', keys: [] },
    { id: 'updates', keys: ['PORTAINER_WEBHOOK_URL'] },
  ];
  const SELF = '/setup/extras';

  let view: SettingsView | null = null, loadFailed = false;
  let status: Partial<Record<CardId, 'done' | 'skipped'>> = {};
  let edits: Record<string, Draft> = {};
  let errors: Record<string, string> = {};
  let notes: Partial<Record<CardId, string>> = {};
  let moved = new Set<string>();
  /** the generated webhook secret: shown once, in memory only */
  let secret = '';

  $: all = new Map((view?.groups ?? []).flatMap((g) => g.items).map((i) => [i.key, i]));
  const rows = (keys: readonly string[]): SettingView[] => keys.map((k) => all.get(k)).filter((v): v is SettingView => Boolean(v));
  $: mediaKind = String(all.get('MEDIA_SERVER')?.value ?? 'jellyfin');

  async function load() {
    loadFailed = false;
    try { view = await loadSettings(); } catch (e) {
      // not an admin (403): nothing to set up here
      if (e instanceof ApiError && e.status === 403) return void goto('/', { replaceState: true });
      if (!view) loadFailed = true;
    }
  }
  onMount(() => {
    void load();
    return keepPageOnSwitch(); // typed values survive a language switch
  });

  function edit(key: string, d: Draft | undefined) {
    if (d === undefined) delete edits[key]; else edits[key] = d;
    edits = edits;
    if (errors[key]) { delete errors[key]; errors = errors; }
  }

  async function save(card: CardId, keys: readonly string[]) {
    const values = changedValues(rows(keys), edits);
    if (!Object.keys(values).length) return;
    notes = { ...notes, [card]: undefined };
    const res = await runAction({ key: `extras:${card}`, run: () => saveSettings(values), success: tr('setup.extras.saved'), error: false });
    if (res.ok) {
      for (const k of Object.keys(values)) delete edits[k];
      edits = edits;
      status = { ...status, [card]: 'done' };
      await load();
      return;
    }
    if (isReauthError(res.error)) return startReauth(SELF);
    const fe = fieldErrors(res.error), pf = probeFailure(res.error);
    if (fe) errors = { ...errors, ...fe };
    if (pf) notes = { ...notes, [card]: tr('settings.probeFailed', { reason: probeText(pf) }) };
    else if (!fe) toast.error(tr('setup.extras.saveFailed'));
  }

  async function move(key: string) {
    const res = await runAction({ key: `extras:move:${key}`, run: () => importEnv([key]), error: tr('settings.moveFailed') });
    if (res.ok && res.value) { moved = new Set([...moved, ...res.value.moved]); await load(); }
  }

  async function genPush() {
    if (all.get('VAPID_PRIVATE_KEY')?.set) {
      const ok = await confirm({ title: tr('settings.generate.vapidConfirm'), body: tr('settings.generate.vapidBody'), danger: true, confirmLabel: tr('setup.extras.cards.push.generate') });
      if (!ok) return;
    }
    // only the public key comes back; it is not shown either: "set" says enough
    const res = await runAction({ key: 'extras:push', run: () => generate('vapidPair'), success: tr('setup.extras.cards.push.done'), error: tr('setup.extras.cards.push.failed') });
    if (res.ok) await load();
    else if (isReauthError(res.error)) startReauth(SELF);
  }

  async function genWebhook() {
    if (all.get('WEBHOOK_SECRET')?.set) {
      const ok = await confirm({ title: tr('settings.generate.webhookConfirm'), body: tr('settings.generate.webhookBody'), danger: true, confirmLabel: tr('setup.extras.cards.webhooks.generate') });
      if (!ok) return;
    }
    const res = await runAction({ key: 'extras:webhook', run: () => generate('webhookSecret'), error: false });
    if (res.ok && res.value) { secret = res.value.secret; await load(); return; }
    if (isReauthError(res.error)) return startReauth(SELF);
    toast.error(tr('setup.extras.cards.webhooks.failed'));
  }

  const skip = (card: CardId) => { status = { ...status, [card]: 'skipped' }; };
  const finish = () => goto('/');
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('setup.extras.pageTitle') })}</title></svelte:head>
<div class="wrap">
  <h1>{$t('setup.extras.title')}</h1>
  <p class="muted intro">{$t('setup.extras.intro')}</p>
  {#if loadFailed}
    <div class="state" role="alert"><Icon name="alert" size={22} /><p>{$t('setup.extras.loadFailed')}</p><Button variant="secondary" icon="refresh" on:click={load}>{$t('ui.retry')}</Button></div>
  {:else if !view}
    <AdminCard><div class="sk" aria-hidden="true"><Skeleton w="12rem" h="2rem" /><Skeleton h="2.8rem" /><Skeleton h="2.8rem" /></div><p class="sr-only" role="status">{$t('ui.table.loading')}</p></AdminCard>
  {:else}
    {#each CARDS as c (c.id)}
      {@const title = $t(`setup.extras.cards.${c.id}.title`)}
      {@const st = status[c.id]}
      {@const dirty = Object.keys(changedValues(rows(c.keys), edits)).length > 0}
      <AdminCard {title} description={st ? '' : $t(`setup.extras.cards.${c.id}.text`)}>
        <svelte:fragment slot="actions">
          {#if st === 'done'}<StatusPill tone="ok" label={$t('setup.extras.done')} />
          {:else if st === 'skipped'}<StatusPill tone="muted" label={$t('setup.extras.skipped')} />{/if}
        </svelte:fragment>
        {#if !st}
          {#if c.id === 'push'}
            {@const priv = all.get('VAPID_PRIVATE_KEY')}
            <div class="line">
              <span>{$t('settings.keys.VAPID_PRIVATE_KEY.label')}</span>
              <StatusPill tone={priv?.set ? 'ok' : 'muted'} label={priv?.set ? $t('settings.secret.set') : $t('settings.secret.unset')} />
            </div>
            {#if priv?.source === 'env'}<p class="muted small">{$t('settings.locked')}</p>{/if}
          {:else if c.id === 'webhooks'}
            {@const ws = all.get('WEBHOOK_SECRET')}
            <div class="line">
              <span>{$t('settings.keys.WEBHOOK_SECRET.label')}</span>
              <StatusPill tone={ws?.set ? 'ok' : 'muted'} label={ws?.set ? $t('settings.secret.set') : $t('settings.secret.unset')} />
            </div>
            {#if secret}
              <div class="secret">
                <CopyField label={$t('setup.extras.cards.webhooks.secret')} value={secret} />
                <CopyField label={$t('setup.extras.cards.webhooks.header')} value={`X-Webhook-Secret: ${secret}`} hint={$t('setup.extras.cards.webhooks.once')} />
              </div>
            {/if}
            <p class="small">{$t('setup.extras.cards.webhooks.urls')}</p>
            <ul class="urls">
              <li><code>http://backend:3000/internal/webhook/{mediaKind}</code></li>
              <li><code>http://backend:3000/internal/webhook/requests</code></li>
            </ul>
          {:else}
            <form novalidate id="extras-{c.id}" on:submit|preventDefault={() => save(c.id, c.keys)}>
              {#each rows(c.keys) as item (item.key)}
                <SettingRow {item} draft={edits[item.key]} error={errors[item.key] ? errorText(errors[item.key]) : ''}
                  movedHint={moved.has(item.key) ? moveHint(item.envNames) : ''} moving={$busyKeys.has(`extras:move:${item.key}`)}
                  on:edit={(e) => edit(item.key, e.detail)} on:move={() => move(item.key)} />
              {/each}
            </form>
          {/if}
          {#if notes[c.id]}<Notice tone="err"><p>{notes[c.id]}</p></Notice>{/if}
          <div class="foot">
            <Button variant="ghost" icon="chevron-right" aria-label={$t('setup.extras.skipA11y', { card: title })} on:click={() => skip(c.id)}>{$t('setup.extras.skip')}</Button>
            {#if c.id === 'push'}
              <Button icon="key" pending={$busyKeys.has('extras:push')} on:click={genPush}>{$t('setup.extras.cards.push.generate')}</Button>
            {:else if c.id === 'webhooks'}
              {#if !secret}<Button icon="key" pending={$busyKeys.has('extras:webhook')} on:click={genWebhook}>{$t('setup.extras.cards.webhooks.generate')}</Button>{/if}
            {:else}
              <Button type="submit" form="extras-{c.id}" icon="check" pending={$busyKeys.has(`extras:${c.id}`)} disabled={!dirty}>{$t('setup.extras.save')}</Button>
            {/if}
          </div>
        {/if}
      </AdminCard>
    {/each}
    <div class="finish"><Button icon="check" on:click={finish}>{$t('setup.extras.finish')}</Button></div>
  {/if}
</div>

<style>
  .wrap { max-width: 760px; margin: 0 auto; min-width: 0; }
  h1 { font-size: 1.8rem; margin: 0 0 .4rem; }
  .intro { margin: 0 0 1.2rem; }
  form { display: grid; gap: .25rem; }
  .line { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .4rem .8rem; padding: .3rem 0; }
  .secret { display: grid; gap: .8rem; margin: .6rem 0; }
  .urls { margin: 0 0 .4rem; padding-left: 1.2rem; display: grid; gap: .3rem; }
  .urls code, .line span { overflow-wrap: anywhere; }
  .small { font-size: .88rem; margin: .4rem 0; }
  .foot { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: .6rem; padding-top: .8rem; margin-top: .6rem; border-top: 1px solid var(--line); }
  .finish { display: flex; justify-content: flex-end; margin-top: 1rem; }
  .sk { display: grid; gap: 1rem; }
  .state { display: flex; flex-direction: column; align-items: center; gap: .6rem; text-align: center; padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  .state p { margin: 0; } .state :global(svg) { color: var(--err); }
  @media (max-width: 480px) { .foot > :global(*), .finish > :global(*) { flex: 1 1 100%; } .finish { display: grid; } }
</style>
