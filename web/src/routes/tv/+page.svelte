<script lang="ts">
  import Logo from '#lib/Logo.svelte';
  import { onDestroy, onMount } from 'svelte';
  import { api } from '#lib/api';
  import { qrPath } from '#lib/qr';
  import { publicLocale, setLocale, t, tr } from '#lib/i18n';
  import Rich from '#lib/i18n/Rich.svelte';

  let code = '', poll = '', expires = 0, error = '', qr: { size: number; d: string } | null = null;
  let timer: ReturnType<typeof setInterval>, dead = false, linking = false;
  /** This page never calls /api/me: language = remembered → browser → instance default (from the first code answer). */
  let langSet = false, shown = false;

  async function newCode() {
    error = '';
    try {
      const r = await api<{ code: string; pollToken: string; expiresIn: number; defaultLanguage?: string }>('/api/tv/code', { method: 'POST' });
      if (!langSet) { langSet = true; await setLocale(r.defaultLanguage); }
      code = r.code; poll = r.pollToken; expires = Date.now() + r.expiresIn * 1000 - 5000;
      qr = qrPath(`${location.origin}/remote?code=${r.code}`);
    } catch { error = tr('player.tv.serverDown'); code = ''; }
    shown = true;
  }
  async function tick() {
    if (dead) return;
    if (!code || Date.now() > expires) return newCode();
    try {
      const r = await api<{ status: string }>('/api/tv/claim', { method: 'POST', body: { code, pollToken: poll } });
      if (r.status === 'ok') { dead = true; linking = true; clearInterval(timer); location.replace('/'); }
    } catch (e: any) { if (e?.status === 404) await newCode(); }
  }

  onMount(async () => {
    document.documentElement.classList.add('tv');
    try { // already a paired TV: straight to the portal
      const r = await fetch('/api/me', { credentials: 'same-origin' });
      if (r.ok && (await r.json()).tv) { location.replace('/'); return; }
    } catch { /* offline: show the code screen anyway */ }
    const pre = publicLocale();
    if (pre) { langSet = true; await setLocale(pre); }
    await newCode();
    if (dead) return;
    timer = setInterval(tick, 2000);
  });
  onDestroy(() => { dead = true; clearInterval(timer); document.documentElement.classList.remove('tv'); });
</script>

<svelte:head><title>{$t('common.pageTitle', { page: $t('player.tv.pageTitle') })}</title></svelte:head>
{#if shown}
<main class="pair">
  <div class="txt">
    <span class="logo"><Logo wordmark size={52} /></span>
    <h1>{$t('player.tv.title')}</h1>
    <ol>
      <li><Rich text={$t('player.tv.step1')} /></li>
      <li>{$t('player.tv.step2')}</li>
    </ol>
    {#if linking}
      <p class="code" role="status">{$t('player.tv.connected')}</p>
    {:else if code}
      <p class="code" aria-live="polite" aria-label={$t('player.tv.codeAria', { code: code.split('').join(' ') })}>{code}</p>
    {:else}
      <p class="code dim" role="status">…</p>
    {/if}
    <p class="muted small">{$t('player.tv.validity')}</p>
    {#if error}<p class="err" role="alert">{error}</p>{/if}
  </div>
  {#if qr}
    <figure class="qr">
      <svg viewBox="-2 -2 {qr.size + 4} {qr.size + 4}" shape-rendering="crispEdges" role="img" aria-label={$t('player.tv.qrAria')}><rect x="-2" y="-2" width={qr.size + 4} height={qr.size + 4} fill="#fff" /><path d={qr.d} fill="#000" /></svg>
      <figcaption class="muted">{$t('player.tv.qrCaption')}</figcaption>
    </figure>
  {/if}
</main>
{/if}

<style>
  .pair { min-height: 100vh; display: flex; align-items: center; justify-content: center; gap: clamp(2rem, 7vw, 7rem); padding: calc(3rem + var(--safe-top)) var(--pad-x) 3rem; background: radial-gradient(900px 500px at 20% 10%, rgba(255, 79, 109, .16), transparent 70%), var(--bg); flex-wrap: wrap; }
  .txt { max-width: 38rem; }
  .logo { display: inline-flex; }
  h1 { font-size: clamp(2rem, 4.5vw, 3.2rem); margin: 1.2rem 0 1rem; }
  ol { color: #e5e5e5; font-size: 1.15rem; padding-left: 1.3rem; display: grid; gap: .5rem; }
  .code { font-size: clamp(2.6rem, 7vw, 5rem); font-weight: 800; letter-spacing: .14em; font-variant-numeric: tabular-nums; margin: 1.2rem 0 .8rem; padding: .3rem 1.2rem; background: var(--surface); border: 2px solid var(--line); border-radius: 12px; display: inline-block; font-family: ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, monospace; }
  .code.dim { opacity: .4; }
  .small { font-size: .95rem; }
  .qr { margin: 0; text-align: center; }
  .qr svg { width: clamp(180px, 24vw, 320px); height: auto; border-radius: 14px; display: block; }
  figcaption { margin-top: .6rem; font-size: .95rem; }
</style>
