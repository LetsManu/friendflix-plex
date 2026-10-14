# Cast bar – keep casting while browsing (design)

Date: 2026-10-13 · Status: approved in chat (architecture), written spec for review

## Goal

While a title plays on a TV via **AirPlay or Chromecast**, the phone/desktop shows the normal app with a **bar docked
at the bottom** (cover, title, play/pause, progress). The user can browse, open other series and start another title,
which then plays **straight on the TV**. Tapping the bar opens the full remote (the watch page) for the running session
without restarting it.

Owner decisions:
- Only while casting. Local playback on the device stays full screen as today (no local mini player).
- "Play" while a cast session runs plays the new title on the TV immediately; the old title's progress is saved.

Not in scope: local mini player / picture-in-picture, party mode (stays without casting, as today), the paired-TV
remote (`/remote`, `lib/remote.ts`), TV mode UI.

## Why it fails today

`Player.svelte` owns everything: the `<video>`, the AirPlay controller (`lib/player/airplay.ts`), the Chromecast calls
(`lib/cast.ts`), progress reporting and the cast token. Leaving `/watch/*` runs `onDestroy`: `castStop()`, `air.destroy()`,
token revoke, `stop` report. Chromecast's session itself is global in the SDK, but AirPlay is bound to the `<video>`
element: when it is unmounted, AirPlay ends.

## Architecture

### `castEngine` (new, `web/src/lib/cast/engine.ts`)

A singleton created once by `+layout.svelte` (lazy: does nothing until a session starts). It owns everything that must
outlive a page while casting:

- **State store** `castSession` (`null` when nothing is cast):
  `{ kind: 'airplay' | 'chromecast', device: string, itemId, seriesId?, title, subtitle (e.g. "S1:E2 · name"),
  posterId, position, duration, paused, buffering, state: 'connecting' | 'playing' | 'reconnect' | 'ended' }`
- **Actions:** `playPause()`, `seek(sec)`, `skip(±10)`, `next()`, `playOnTv(itemId, startAt?)`, `stop()`,
  `reconnect()` (AirPlay picker, must run in a tap handler), `adopt(from: PlayerHandoff)`.
- **AirPlay:** the engine owns one hidden `<video playsinline>` that is appended to `document.body` once and never
  removed while a session lives. It carries the token stream URL (`/media/c/<token>/…`) and is never shown; while
  routed, picture and sound go to the TV only. The existing
  AirPlay controller logic (`createAirPlay`: token first, grace, settle, breaker, log) is reused on this element.
- **Chromecast:** uses the existing `lib/cast.ts` functions. Leaving a page no longer calls `castStop()`.
- **Progress:** reports `start` / `progress` (every 10 s and on pause, seek, end) / `stop` via the same
  `/api/playback/*` calls the Player uses today, but only for the cast session. `pagehide` sends `stop` with keepalive
  as today.
- **Token:** one cast token per title (`/api/cast/session`); revoked on `stop()`, on title switch (old token) and on
  `pagehide`.
- **Next episode:** at the end of an episode the engine asks `GET /api/items/{id}/next` and, after the existing
  countdown length, calls `playOnTv(next)`. Autoplay preferences (existing "autoplay next" setting) apply.

### Player hand-off

- When casting starts in `Player.svelte`, the Player calls `castEngine.adopt(handoff)` with the item, position, token,
  tracks and – for AirPlay – **moves its own `<video>` element into the engine** (DOM move, not a copy, so the AirPlay
  route is not touched). The Player then renders the existing cast UI (`CastPeek`, controls) from `castSession`
  instead of its own element and **does not** stop casting in `onDestroy` while the engine owns the session.
- Opening `/watch/<id>` while `castSession.itemId === id`: the Player attaches to the engine (no new token, no
  `playback/info` restart), shows the remote UI.
- Opening `/watch/<other id>` while casting: equals `playOnTv(other)` and shows the remote UI.
- Party mode: unchanged (no casting, engine never involved).

### Play buttons

`playPath()` links stay. A small helper `playOrCast(e, item)` is used by the play buttons (preview sheet, detail page,
episode list, continue-watching): when `castSession` is set, it prevents navigation and calls `playOnTv(item.id)`
(with the item's resume position), shows a toast "Playing on <device>"; otherwise the link navigates as today.

### Cast bar (`web/src/lib/cast/CastBar.svelte`)

Mounted in `+layout.svelte`, shown when `castSession` is set and the current page is not `/watch/*` or `/party/*`, not
TV mode.

- **Phone:** docked directly above the tab bar (`bottom: calc(56px + var(--safe-bottom))`), full width, 64 px high;
  `main` gets extra bottom padding while the bar is shown. Above the offline banner's layer.
- **Desktop:** docked at the bottom edge, max width like the content, same layout.
- Content: poster thumb (16:9 still for episodes, poster for movies), two lines (title / "S1:E2 · Episode name ·
  on <device>"), a play/pause button and a stop button (48 px hit areas each). Stop opens the existing confirm dialog
  "Stop playback on <device>?". A 2 px progress line runs along the top edge.
- Tap on the text/cover area → `goto('/watch/<itemId>')` (attaches, see above).
- States: `connecting` (spinner instead of play/pause), `reconnect` (text "Connection lost – tap to continue on TV",
  the tap calls `reconnect()` which opens the picker inside the gesture), `ended` (bar disappears after 5 s unless a
  next episode is coming, then "Next: …" with the countdown).
- Look: FriendFlix's own tokens (surface `--card`, accent, radius from the UI kit); no other service's look.
- A11y: `role="region"` with label "Now on TV", buttons with labels, progress as `aria-valuenow` on a hidden
  `progressbar`, keyboard reachable, `prefers-reduced-motion` respected.
- i18n: all strings in all 7 languages.

## AirPlay risk and how it is handled

Native apps (`AVPlayer.replaceCurrentItem`) keep one player alive and swap its content. The engine does the web
equivalent:

1. **Navigation no longer touches the element** (engine owns it in `document.body`) – this removes the cause of the
   current stop.
2. **Title switch = new `src` on the same element.** Safari keeps the AirPlay choice per page and reconnects on its own
   (iOS keeps the connection alive; a new video after reload even starts routed). The existing 4 s wireless-off grace
   and 1.5 s settle cover a short flap; `video.remote.state` (Remote Playback API, where present) is an extra signal.
3. **Fallback:** if the route is still off after the grace, `state = 'reconnect'`; one tap on the bar re-opens the
   picker (a user gesture is required by Safari) and resumes at the saved position.

**Gate:** Phase 1 ends with an on-device check on the owner's iPhone + LG TV: switch titles three times while casting,
browse between pages for 5 minutes. The `/diagnose` AirPlay log must show no route loss (or only flaps within the
grace). Phases 2–3 start after that check; if the route drops on every switch, the fallback becomes the documented
behaviour for AirPlay title switches and the spec is amended.

## Error handling

- Token request fails / 429: bar shows `reconnect` with the error toast used by the Player today; breaker limits apply.
- Chromecast session ended from another device or the TV: `castSession` → null, bar disappears, progress `stop` sent.
- Item not playable on the receiver (variant fallback fails): toast "Can't play this title on <device>", previous title
  is not restored, bar shows the stopped state with "Play here" (opens `/watch/<id>` locally).
- Logout / profile switch: `stop()` first.
- Kids profile: `playOnTv` respects the same rating checks (server-side via playback info).

## Testing

- Unit (Vitest, fakes like the existing cast/airplay tests): engine state machine – adopt, playOnTv (token swap +
  revoke), progress reporting cadence, next-episode flow, reconnect state after grace, stop on logout; `playOrCast`
  helper. Coverage thresholds must hold.
- e2e (Playwright, existing cast fakes): bar appears after starting a cast and leaving the watch page; play/pause and
  stop from the bar; tapping Play on another title while casting keeps the user on the page and updates the bar;
  tapping the bar reopens the remote without a new session request; phone + desktop; a11y names.
- Manual (gate above): real iPhone + AirPlay TV, and Chrome + Chromecast.

## Phases

1. Engine + AirPlay/Chromecast hand-off + navigation survives + `playOnTv` switch (minimal bar: title + play/pause) →
   on-device gate.
2. Full bar UI (phone/desktop, states, a11y, i18n), `playOrCast` on all play buttons, next-episode flow.
3. Docs (README feature line, docs/player or casting doc, CHANGELOG), Plex fork port (engine is media-server neutral;
   only verify).
