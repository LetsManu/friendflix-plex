<script lang="ts">
  let innerWidth = 1200;
  import { onDestroy, onMount, tick } from 'svelte';
  import { pageStore } from '#lib/page';
  const page = pageStore();
  import { goto } from '$app/navigation';
  import Icon from '#lib/Icon.svelte';
  import { api } from '#lib/api';
  import Player from '#lib/Player.svelte';
  import { t, tr, fmtList } from '#lib/i18n';

  const EMOJIS = ['😂', '😮', '❤️', '👍', '😢', '🔥']; // same whitelist as the server (backend/src/party.ts)
  const FLOAT_MS = 2500;
  const DRIFT = 0.3; // seconds: seek when further apart than ~300 ms
  type Member = { id: string; name: string; buffering: boolean };
  let video: HTMLVideoElement | null = null;
  let ws: WebSocket | null = null;
  let itemId = '', title = '', you = '', hostId = '', mode: 'host' | 'everyone' = 'host', startAt: number | undefined;
  let members: Member[] = [];
  let chat: Array<{ id: number; name: string; text: string; mine: boolean }> = [], recent: typeof chat = [], text = '', unread = 0, panel = false, settings = false, copied = false;
  let floating: Array<{ id: number; emoji: string; left: number; name: string }> = [], liveMsg = '';
  let state = { playing: false, position: 0, at: 0, hold: false };
  let offset = 0, bestRtt = Infinity, error = '', needClick = false, countdown = '', ready = false, n = 0, closing = false;
  let timers: ReturnType<typeof setInterval>[] = [], reconnect: ReturnType<typeof setTimeout> | undefined, bound: HTMLVideoElement | null = null;
  let suppressUntil = 0, chatEl: HTMLDivElement;

  $: isHost = you !== '' && you === hostId;
  $: canControl = isHost || mode === 'everyone';
  $: waitingFor = members.filter((m) => m.buffering).map((m) => m.name);
  const serverNow = () => Date.now() + offset;
  const expected = () => (state.playing && !state.hold ? state.position + (serverNow() - state.at) / 1000 : state.position);
  const send = (m: object) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

  // programmatic play/pause/seek must not be echoed back to the room: only mark right before a real mutation
  const quiet = () => (suppressUntil = Date.now() + 450);
  async function apply() {
    if (!video || !ready) return;
    const exp = expected();
    const drift = video.currentTime - exp;
    if (state.hold || !state.playing) {
      if (!video.paused) { quiet(); video.pause(); }
      if (Math.abs(drift) > 0.1) { quiet(); video.currentTime = exp; }
    } else {
      if (Math.abs(drift) > DRIFT) { quiet(); video.currentTime = exp; }
      video.playbackRate = Math.abs(drift) > 0.08 && Math.abs(drift) <= DRIFT ? (drift > 0 ? 0.95 : 1.05) : 1;
      if (video.paused) { quiet(); await video.play().catch(() => (needClick = true)); }
    }
  }

  function connect() {
    if (closing) return;
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/party/${$page.params.id}`);
    ws.onclose = (e) => { if (closing) return; if (e.code === 4404) error = tr('social.party.notFound'); else if (e.code === 4409) error = tr('social.party.full'); else if (e.code === 4401) error = tr('social.party.relogin'); else reconnect = setTimeout(connect, 2000); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'welcome') { ({ you, hostId, itemId, title, startAt } = m); mode = m.mode; members = m.members; state = m.state; offset = m.serverNow - Date.now(); }
      else if (m.t === 'members') { hostId = m.hostId; mode = m.mode; members = m.members; }
      else if (m.t === 'state') { state = m.state; offset = m.serverNow - Date.now(); apply(); }
      else if (m.t === 'chat') {
        const msg = { id: ++n, name: m.name, text: m.text, mine: m.from === you };
        chat = [...chat.slice(-199), msg];
        recent = [...recent.slice(-3), msg]; setTimeout(() => (recent = recent.filter((r) => r.id !== msg.id)), 9000);
        if (!panel && !msg.mine) unread++;
        tick().then(() => chatEl && (chatEl.scrollTop = chatEl.scrollHeight));
      }
      else if (m.t === 'react') { const id = ++n; floating = [...floating.slice(-23), { id, emoji: m.emoji, left: 6 + Math.random() * 80, name: m.name }]; liveMsg = tr('together.party.reacted', { name: m.name, emoji: m.emoji }); setTimeout(() => (floating = floating.filter((f) => f.id !== id)), FLOAT_MS); }
      else if (m.t === 'pong') { const rtt = Date.now() - m.c; if (rtt < bestRtt || Math.random() < 0.1) { bestRtt = Math.min(rtt, bestRtt * 1.2); offset = m.s + rtt / 2 - Date.now(); } }
    };
  }

  function bindVideo() {
    if (!video || video === bound) return;
    bound = video;
    const control = (playing: boolean) => { if (canControl && Date.now() > suppressUntil) send({ t: 'state', playing, position: video!.currentTime }); };
    video.addEventListener('play', () => control(true));
    video.addEventListener('pause', () => control(false));
    video.addEventListener('seeked', () => control(!video!.paused));
    video.addEventListener('waiting', () => send({ t: 'buffering', value: true }));
    for (const ev of ['canplay', 'playing', 'seeked']) video.addEventListener(ev, () => send({ t: 'buffering', value: false }));
  }
  function onReady() { ready = true; bindVideo(); send({ t: 'buffering', value: true }); video?.addEventListener('canplay', () => apply(), { once: true }); }

  const sendChat = () => { if (text.trim()) { send({ t: 'chat', text }); text = ''; } };
  const react = (emoji: string) => send({ t: 'react', emoji });
  // keys 1-6 send the matching reaction (not while typing, not with modifiers)
  function onKey(e: KeyboardEvent) {
    const el = e.target as HTMLElement | null;
    if (e.ctrlKey || e.metaKey || e.altKey || el?.closest('input, textarea, select, [contenteditable]')) return;
    const emoji = EMOJIS[Number(e.key) - 1];
    if (emoji && e.key.length === 1) react(emoji);
  }
  const setMode = (v: 'host' | 'everyone') => send({ t: 'mode', value: v });
  function togglePanel() { panel = !panel; settings = false; if (panel) { unread = 0; tick().then(() => chatEl && (chatEl.scrollTop = chatEl.scrollHeight)); } }
  async function copyLink() { try { await navigator.clipboard.writeText(location.href); copied = true; setTimeout(() => (copied = false), 1800); } catch { /* ignore */ } }
  // ---- one tap invitation: pick friends (they get a notification) or share the link ----
  let invite = false, friends: Array<{ id: string; name: string }> = [], picked = new Set<string>(), inviteMsg = '', autoShown = false;
  async function openInvite() { invite = true; inviteMsg = ''; if (!friends.length) friends = (await api('/api/friends').catch(() => ({ friends: [] }))).friends; }
  const pick = (id: string) => { const s = new Set(picked); if (s.has(id)) s.delete(id); else s.add(id); picked = s; };
  async function sendInvite() {
    try { const r = await api(`/api/party/${$page.params.id}/invite`, { method: 'POST', body: { userIds: [...picked] } }); inviteMsg = r.sent ? tr('social.party.invitesSent', { n: r.sent }) : tr('social.party.allInvited'); picked = new Set(); }
    catch { inviteMsg = tr('social.party.inviteFailed'); }
  }
  async function shareLink() { if (navigator.share) { try { await navigator.share({ title: tr('social.party.shareTitle', { title }), url: location.href }); return; } catch { /* cancelled */ } } copyLink(); }
  // alone in a fresh room: show the invitation right away (that is what you want to do next)
  $: if (ready && isHost && members.length === 1 && !autoShown) { autoShown = true; openInvite(); }
  const back = () => (history.length > 1 ? history.back() : goto('/party'));
  const initial = (s: string) => s.slice(0, 1).toUpperCase();

  onMount(() => {
    connect();
    timers.push(setInterval(() => send({ t: 'ping', c: Date.now() }), 3000));
    timers.push(setInterval(apply, 1000)); // continuous drift correction
    timers.push(setInterval(() => { countdown = startAt && Date.now() < startAt ? tr('social.party.countdown', { s: Math.max(0, Math.ceil((startAt - serverNow()) / 1000)) }) : ''; }, 500));
  });
  onDestroy(() => { closing = true; clearTimeout(reconnect); timers.forEach(clearInterval); ws?.close(); });
</script>

<svelte:window bind:innerWidth on:keydown={onKey} />
<svelte:head><title>{$t('common.pageTitle', { page: title || $t('social.party.title') })}</title></svelte:head>
<div class="wrap">
  {#if error}<div class="fatal"><p class="err">{error}</p><a class="btn" href="/party">{$t('social.party.backToList')}</a></div>{/if}
  {#if itemId}
    <Player itemId={itemId} bind:video partyMode {canControl} inset={panel && innerWidth > 720 ? 340 : 0} denyHint={$t('social.party.denyHint')} on:ready={onReady}>
      <div slot="top" class="top">
        <button class="icon-btn" aria-label={$t('social.party.leave')} on:click={back}><Icon name="arrow-left" size={30} /></button>
        <div class="ttl"><b>{title}</b><span>{$t('social.party.title')}{#if countdown}{' · '}{countdown}{/if}</span></div>
        <span class="sp"></span>
        <ul class="avatars" aria-label={$t('social.party.participants', { n: members.length })}>
          {#each members as m (m.id)}
            <li class:buf={m.buffering} title="{m.name}{m.id === hostId ? ' ' + $t('social.party.hostSuffix') : ''}{m.buffering ? ' – ' + $t('social.party.loadingSuffix') : ''}">
              <span class="av">{initial(m.name)}</span>{#if m.id === hostId}<span class="crown"><Icon name="crown" size={12} fill /></span>{/if}
            </li>
          {/each}
        </ul>
        <button class="icon-btn" aria-label={$t('social.party.inviteFriends')} title={$t('social.party.inviteFriends')} on:click={openInvite}><Icon name="users" size={24} /></button>
        <button class="icon-btn" aria-label={$t('social.party.copyLink')} title={$t('social.party.copyLink')} on:click={copyLink}><Icon name={copied ? 'check' : 'link'} size={24} /></button>
      </div>
      {#if invite}
        <div class="invite ui" role="dialog" tabindex="-1" aria-label={$t('social.party.inviteFriends')} on:click|stopPropagation on:keydown|stopPropagation>
          <header><b>{$t('social.party.inviteTitle')}</b><button class="icon-btn" aria-label={$t('common.close')} on:click={() => (invite = false)}><Icon name="x" size={20} /></button></header>
          <div class="flex">{#each friends as f}<label class="chk"><input type="checkbox" checked={picked.has(f.id)} on:change={() => pick(f.id)} />{f.name}</label>{:else}<span class="muted">{$t('social.noOtherUsers')}</span>{/each}</div>
          <div class="flex"><button disabled={!picked.size} on:click={sendInvite}>{$t('social.invite')}</button><button class="sec" on:click={shareLink}><Icon name={copied ? 'check' : 'share'} size={18} />{$t('social.party.shareLink')}</button></div>
          {#if inviteMsg}<span class="muted" role="status">{inviteMsg}</span>{/if}
        </div>
      {/if}

      {#if state.hold && waitingFor.length}<div class="hold" role="status"><div class="spin"></div>{$t('social.party.waitingFor', { names: fmtList(waitingFor) })}</div>{/if}
      {#if needClick}<div class="hold"><button on:click|stopPropagation={() => { needClick = false; apply(); }}><Icon name="play" size={20} />{$t('social.party.watchAlong')}</button></div>{/if}

      <div class="floats" aria-hidden="true">{#each floating as f (f.id)}<span class="fl" style="left:{f.left}%"><b>{f.emoji}</b><i><span class="fav">{initial(f.name)}</span>{f.name}</i></span>{/each}</div>

      <div class="rbar ui" class:shift={panel && innerWidth > 720} role="group" aria-label={$t('together.party.reactions')} on:click|stopPropagation on:keydown|stopPropagation>
        {#each EMOJIS as e, i}<button class="em" title={String(i + 1)} aria-label={$t('together.party.react', { emoji: e })} on:click={() => react(e)}>{e}</button>{/each}
      </div>
      <span class="sr" role="status" aria-live="polite">{liveMsg}</span>

      {#if !panel && recent.length}
        <ul class="bubbles" aria-live="polite">{#each recent as r (r.id)}<li><b>{r.name}</b> {r.text}</li>{/each}</ul>
      {/if}

      {#if panel}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <aside class="chat" aria-label={$t('social.party.chat')} on:click|stopPropagation on:keydown|stopPropagation>
          <header><b>{$t('social.party.chat')}</b><button class="icon-btn" aria-label={$t('social.party.closeChat')} on:click={togglePanel}><Icon name="x" size={22} /></button></header>
          <div class="msgs" bind:this={chatEl} role="log" aria-live="polite">
            {#each chat as c (c.id)}<p class:mine={c.mine}><b>{c.name}</b><span>{c.text}</span></p>{:else}<p class="muted">{$t('social.party.noMessages')}</p>{/each}
          </div>
          <form on:submit|preventDefault={sendChat}><input bind:value={text} maxlength="500" placeholder={$t('social.party.messagePlaceholder')} aria-label={$t('social.party.message')} /><button aria-label={$t('social.party.send')}><Icon name="chevron-right" size={20} /></button></form>
        </aside>
      {/if}

      <svelte:fragment slot="extra">
        {#if isHost}
          <div class="mwrap">
            <button class="ic" aria-label={$t('social.party.settings')} aria-expanded={settings} on:click|stopPropagation={() => { settings = !settings; }}><Icon name={mode === 'everyone' ? 'users' : 'lock'} size={26} /></button>
            {#if settings}
              <div class="menu" role="dialog" tabindex="-1" aria-label={$t('social.party.whoControls')} on:click|stopPropagation on:keydown|stopPropagation>
                <h3>{$t('social.party.whoControls')}</h3>
                <button class="mi" class:on={mode === 'host'} on:click={() => setMode('host')}>{#if mode === 'host'}<Icon name="check" size={16} />{:else}<span class="sp2"></span>{/if}{$t('social.party.onlyMe')}</button>
                <button class="mi" class:on={mode === 'everyone'} on:click={() => setMode('everyone')}>{#if mode === 'everyone'}<Icon name="check" size={16} />{:else}<span class="sp2"></span>{/if}{$t('social.party.everyone')}</button>
              </div>
            {/if}
          </div>
        {:else}
          <span class="roleinfo" title={mode === 'everyone' ? $t('social.party.everyoneControls') : $t('social.party.hostControls')}><Icon name={mode === 'everyone' ? 'users' : 'lock'} size={22} /></span>
        {/if}
        <button class="ic chatbtn" aria-label={unread ? $t('social.party.chatUnread', { label: panel ? $t('social.party.closeChat') : $t('social.party.openChat'), n: unread }) : panel ? $t('social.party.closeChat') : $t('social.party.openChat')} aria-expanded={panel} on:click|stopPropagation={togglePanel}>
          <Icon name="message" size={27} />{#if unread}<span class="dot">{unread}</span>{/if}
        </button>
      </svelte:fragment>
    </Player>
  {:else if !error}<div class="fatal"><div class="spin"></div><p class="muted">{$t('social.party.connecting')}</p></div>{/if}
</div>

<style>
  .wrap { position: fixed; inset: 0; background: #000; z-index: 40; }
  .wrap :global(.stage) { height: 100%; }
  .fatal { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 1rem; }
  .top { padding: .8rem 1rem; display: flex; align-items: center; gap: .6rem; background: linear-gradient(rgba(0,0,0,.8), transparent); }
  .ttl { display: flex; flex-direction: column; line-height: 1.2; min-width: 0; } .ttl b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .ttl span { color: var(--mut); font-size: .88rem; }
  .sp { flex: 1; }
  .avatars { display: flex; list-style: none; margin: 0 .4rem 0 0; padding: 0; }
  .avatars li { position: relative; margin-left: -8px; }
  .av { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; background: linear-gradient(135deg, #ff4f6d, #9a2440); border: 2px solid #000; font-weight: 800; font-size: .9rem; }
  .buf .av { outline: 2px solid var(--warn); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .55; } }
  .crown { position: absolute; right: -4px; top: -6px; color: #f5c518; }
  .hold { position: absolute; left: 50%; top: 14%; transform: translateX(-50%); background: rgba(16,20,24,.92); padding: .7rem 1.3rem; border-radius: 999px; display: flex; gap: .7rem; align-items: center; z-index: 9; }
  .spin { width: 20px; height: 20px; border: 3px solid #4a5560; border-top-color: var(--acc); border-radius: 50%; animation: sp .9s linear infinite; } @keyframes sp { to { transform: rotate(360deg); } }
  .floats { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 6; }
  .fl { position: absolute; bottom: 26%; display: flex; flex-direction: column; align-items: center; animation: up 2.5s ease-out forwards; }
  .fl b { font-size: 2.4rem; } .fl i { font-style: normal; font-size: .72rem; background: rgba(0,0,0,.6); padding: 0 .5rem 0 .15rem; border-radius: 99px; display: inline-flex; align-items: center; gap: .3rem; }
  .fav { display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: linear-gradient(135deg, #ff4f6d, #9a2440); font-weight: 800; font-size: .65rem; }
  @keyframes up { 0% { transform: translateY(0) scale(.7); opacity: 0; } 12% { opacity: 1; transform: translateY(-20px) scale(1); } 100% { transform: translateY(-300px); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .fl { animation: fade 2.5s linear forwards !important; } /* fade only; beats the global reduced-motion kill switch */ @keyframes fade { from { opacity: 1; } 70% { opacity: 1; } to { opacity: 0; } } }
  .rbar { position: absolute; right: .8rem; bottom: 9.5rem; z-index: 8; display: flex; gap: .1rem; background: rgba(16,20,24,.82); border: 1px solid #323a43; border-radius: 99px; padding: .15rem .3rem; }
  .rbar.shift { right: calc(340px + .8rem); }
  .rbar .em { width: 40px; min-height: 40px; font-size: 1.35rem; border-radius: 50%; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .bubbles { position: absolute; left: clamp(.8rem, 2.4vw, 2.4rem); bottom: 9.5rem; list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; max-width: min(420px, 70vw); z-index: 6; pointer-events: none; }
  .bubbles li { background: rgba(0,0,0,.62); padding: .35rem .8rem; border-radius: 14px; font-size: .92rem; animation: fadein .25s; } @keyframes fadein { from { opacity: 0; transform: translateY(6px); } }
  .chat { position: absolute; top: 0; right: 0; bottom: 0; width: min(340px, 92vw); background: rgba(14,14,14,.94); z-index: 10; display: flex; flex-direction: column; border-left: 1px solid #252c34; animation: slide var(--t-med) var(--ease); }
  @keyframes slide { from { transform: translateX(100%); } }
  .chat header { display: flex; justify-content: space-between; align-items: center; padding: .6rem .6rem .6rem 1rem; border-bottom: 1px solid #252c34; }
  .msgs { flex: 1; overflow-y: auto; padding: .8rem 1rem; display: flex; flex-direction: column; gap: .5rem; }
  .msgs p { margin: 0; display: flex; flex-direction: column; background: #1d2329; padding: .4rem .7rem; border-radius: 10px; align-self: flex-start; max-width: 90%; word-break: break-word; }
  .msgs p.mine { align-self: flex-end; background: #5e1a2a; } .msgs b { font-size: .75rem; color: var(--mut); }
  .chat form { display: flex; gap: .4rem; padding: .7rem; border-top: 1px solid #252c34; } .chat input { flex: 1; min-width: 0; }
  .ic { background: transparent; padding: 0; width: 48px; min-height: 48px; border-radius: 50%; color: #fff; position: relative; } .ic:hover:not(:disabled) { background: rgba(255,255,255,.14); }
  .roleinfo { display: grid; place-items: center; width: 40px; color: var(--mut); }
  .mwrap { position: relative; }
  .em { background: transparent; font-size: 1.6rem; width: 48px; padding: 0; } .em:hover:not(:disabled) { background: rgba(255,255,255,.12); transform: scale(1.15); }
  .menu { position: absolute; right: 0; bottom: 58px; background: rgba(16,20,24,.97); border: 1px solid #323a43; border-radius: 6px; padding: .6rem .3rem; min-width: 210px; z-index: 20; }
  .menu h3 { font-size: 1rem; margin: 0 .6rem .4rem; }
  .mi { display: flex; width: 100%; justify-content: flex-start; align-items: center; gap: .5rem; background: transparent; color: #d2d2d2; font-weight: 400; padding: .35rem .6rem; min-height: 40px; border-radius: 4px; } .mi.on { color: #fff; font-weight: 700; } .mi:hover:not(:disabled) { background: rgba(255,255,255,.1); }
  .sp2 { width: 16px; flex: none; }
  .dot { position: absolute; top: 6px; right: 4px; background: var(--acc-fill); font-size: .65rem; min-width: 1.1rem; height: 1.1rem; border-radius: 99px; display: grid; place-items: center; font-weight: 700; }
  @media (max-width: 720px) { .avatars { display: none; } .bubbles { bottom: 12rem; } .rbar { right: 50%; transform: translateX(50%); bottom: 9rem; } .rbar .em { width: 36px; min-height: 36px; font-size: 1.2rem; } }
.invite { position: absolute; top: 4.6rem; right: 1rem; z-index: 12; background: rgba(16,20,24,.97); border: 1px solid #323a43; border-radius: 10px; padding: 1rem 1.2rem; width: min(380px, 92vw); display: grid; gap: .8rem; } .invite header { display: flex; justify-content: space-between; align-items: center; } .chk { display: inline-flex; gap: .45rem; align-items: center; color: var(--fg); min-height: 40px; }
</style>
