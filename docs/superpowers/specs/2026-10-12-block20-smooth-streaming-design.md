# Block 20 – Smooth streaming (design)

Status: approved in chat on 2026-10-12, pending review of this written spec.
Scope: FriendFlix main repo first; ported to the Plex fork (LetsManu/friendflix-plex) after merge.
Follow-up: Block 21 "Info & care" (detail page, admin health, library hygiene) gets its own spec.

## Goal and context

Friends watch FriendFlix over the internet on PC, phones/tablets and TVs. Remote viewing buffers, looks bad
or aborts. Viewers should get playback that adapts to their connection, controls that are comfortable on
phone and PC, and a home page that appears quickly.

Findings from the code (2026-10-12):
- No adaptive bitrate. "Auto" means the role maximum (friend 20, family 40, guest 8, admin 60 Mbit/s;
  `backend/src/roles.ts`). Each stream gets a single HLS variant (`backend/src/jellyfin/service.ts`,
  `dto.ts`) and the client measures no bandwidth.
- Direct play happens whenever the source fits the role cap, whatever the viewer's connection.
- Errors (`web/src/lib/player/retry.ts`, `Player.svelte`): network errors retry 3 times and then fail,
  without stepping quality down. Stalls (`waiting`) only show a spinner.
- hls.js uses `maxBufferLength 30`, `maxMaxBufferLength 60` and default retry policies
  (`web/src/lib/player/hls.ts`).
- The reverse-proxy docs are already streaming-friendly (no buffering, long timeouts, HTTP/2), so the proxy
  is not the cause.
- The home page fires about 16 API calls before first paint and has no aggregated endpoint
  (`web/src/routes/+page.svelte`, `web/src/lib/home.ts`).

Non-goals: a server-side multi-variant ABR ladder; new external services or API keys; changing TV-mode
behaviour (it must keep working and is tested).

## 1. Automatic quality

### Bandwidth estimate (web)
- A new module `web/src/lib/player/bandwidth.ts` (pure, unit-tested) estimates throughput from loaded
  segments or byte ranges.
  - It uses an EWMA with outlier damping and ignores segments that are too small to measure.
  - For hls.js it uses fragment load stats. For direct play it uses progress events and buffered growth
    over time.
- The last estimate is stored per device (`localStorage`, key `ff_bw`, with a timestamp). Estimates older
  than 7 days are ignored.

### Ladder and choice
- Ladder: Original, then 1080p 8 Mbit/s, 720p 4 Mbit/s, 480p 1.5 Mbit/s, 360p 0.8 Mbit/s. This is the
  existing `QUALITIES` list plus "Original".
- "Auto" picks the highest rung ≤ estimate × 0.7 (headroom) and ≤ the effective cap (role cap, or the
  remote cap when remote).
  - Without an estimate it starts at a conservative 720p / 4 Mbit/s.
- Direct play is chosen only if the source bitrate ≤ estimate × 0.7, in addition to the existing container
  and codec checks. The client passes the estimate as `maxBitrate`, and the backend keeps
  `cap = min(role cap, remote cap, client maxBitrate)`.
- A manual choice in the menu pins the rung. Auto switching is then off, except for step-down after a
  fatal stall or abort, and the user is told about it.

### Reacting
- A new pure, unit-tested module `web/src/lib/player/abr.ts` handles switching:
  - **Stall:** a `waiting` that lasts > 2 s, or 3 stalls within 60 s, steps down one rung.
  - **Network error:** after the first retry fails, step down one rung instead of failing. Only fail at the
    lowest rung.
  - **Step-up:** at most once every 60 s, only when the estimate has been ≥ the next rung's bitrate ÷ 0.6
    for 30 s and the buffer is healthy (≥ 20 s).
  - **Switching:** keeps the position and audio/subtitle choice. It uses the existing quality-change path
    (new playbackInfo) and stops the old transcode session (`stopEncoding`).
- hls.js tuning:
  - `maxBufferLength 60`, `maxMaxBufferLength 120`
  - explicit `fragLoadPolicy` / `manifestLoadPolicy` with more retries and backoff
  - `backBufferLength` stays 90

### Remote limit (backend, enforced server-side)
- A new per-role setting, `remoteMaxBitrate`, holds the bitrate for requests from outside the home network.
  Default 8 Mbit/s for friend and family, 4 Mbit/s for guest, 12 Mbit/s for admin (owner upload measured 33 Mbit/s, so three remote 1080p viewers fit).
- A new setting holds the home-network ranges (`HOME_NETWORKS`, CIDR list).
  - Default: RFC1918 + loopback + IPv6 ULA.
  - It is evaluated on the real client IP (trusted proxy headers, as for existing rate limits).
- Applied in `POST /api/playback/info` (`backend/src/routes/media.ts`) and in the gateway clamp on
  bitrate query params (`gateway/src/gateway.ts`, `auth.maxBitrate`), so it cannot be bypassed from the
  browser.
- The admin roles page edits `remoteMaxBitrate` (kit `Field`/`Select`, all 7 languages).

### Showing why
- A small chip in the player shows "Original" or "Converted · 720p". It opens a short reason:
  - connection slow
  - format not supported by this browser
  - audio track needs conversion
  - remote limit
  - manual choice
- The reason comes from playbackInfo: a new optional field, `transcodeReason`, mapped from Jellyfin's
  TranscodeReasons plus our own cap reasons. The seam DTO field is additive, and the Plex fork maps its
  decision reasons.

## 2. Player controls on phone and PC

### Phone (coarse pointer)
Gestures live in the existing `web/src/lib/player/gestures.ts` (unit-tested):
- **Double-tap** left or right: ±10 s; repeated taps add up, with an on-screen counter.
- **Horizontal drag:** seek, with the trickplay thumbnail and the target time.
- **Vertical drag** on the right half: volume. On the left half: brightness, as a dimming overlay
  (browsers cannot set screen brightness), reset per session.
- **Lock button:** disables all touch controls until unlocked with a long press on the lock icon.

Layout and orientation:
- Bigger targets (≥ 48 px).
- Fewer buttons in the main bar; rarely used actions move into "More".
- On play, request fullscreen plus landscape orientation where the browser allows it, and fail silently
  otherwise.

### PC (fine pointer)

| Key | Action |
|---|---|
| Space / K | play/pause |
| J / L | ±10 s |
| ← / → | ±5 s |
| ↑ / ↓ | volume |
| F | fullscreen |
| M | mute |
| C | subtitles on/off (last used track) |
| < / > | speed |
| 0–9 | seek to 0–90 % |
| ? | help |

- The key map lives in `web/src/lib/player/keymap.ts`, extending the existing one without breaking TV
  keys. Every action shows a short centred feedback bubble.
- Mouse: the wheel over the video changes volume; double-click toggles fullscreen.
- Menus close on an outside click and on Esc, and focus returns to the opener. This builds on the menu fix
  from PR #104.

## 3. Faster home page

- New `GET /api/home` (backend, new route file `backend/src/routes/home.ts`). It returns everything above
  the fold in one response:
  - hero
  - resume
  - next up
  - leaving soon
  - recommendations
  - "because you watched" rows
  - brand hubs
  - themed lists

  It uses the same visibility rules as the existing endpoints (role libraries, age caps, kids profiles) by
  calling the same internal functions, and runs the parts in parallel with per-part error isolation: a
  failing part returns empty plus a flag, never a 500.
- Server cache:
  - short TTL (60 s) per profile + user-data version (`userDataVersion`)
  - invalidated by the existing touch on watched / list / rating changes
- Web:
  - `+page.svelte` / `home.ts` switch to `/api/home` for the first screen; idle and scroll rows stay as
    they are
  - the existing SWR cache keeps showing the last home instantly
  - the first visible poster row gets `fetchpriority="high"`; the rest stay lazy
- Old endpoints stay (backward compatible).
- Measurement: an e2e check counts API requests before first paint (target ≤ 5), and the PR reports
  before/after timing from a local measurement.

## 4. Smooth transition into the player (added 2026-10-12, approved in chat)

- **Poster instead of an empty stage:** from the first frame of the player route, it shows the title's backdrop, dimmed, with the title and a thin progress bar, then crossfades over 300 ms to the video when the first frame arrives.
- **Shared-element view transition:** the clicked artwork (card, billboard or detail) grows into the player poster. Without the View Transitions API there is a 200 ms fade. Reduced motion gets a short fade only. TV mode is unchanged.
- **Prefetch:** hovering, focusing or touching a play control starts `/api/playback/info` early; the player reuses the result for up to 30 s. The route code and hls.js are already prefetched today.
- **Calm build-up:** no header, control-bar, white or black flash; the controls appear once playback runs.
- **Back:** leaving the player returns to the previous page at the same scroll position.

## Error handling

- ABR never loops. A step-down cooldown of 10 s and a floor at 360p apply; at the floor the existing error
  screen (retry button) is shown.
- If `/api/home` partially fails, the page renders the parts it got and the existing per-row loaders fill
  the gaps.
- If remote detection is ambiguous (no trusted IP), it is treated as remote, so the safer, lower cap
  applies.

## Testing

- Backend:
  - remote vs home network cap, including a spoofed `X-Forwarded-For` from an untrusted source
  - `transcodeReason` mapping
  - `/api/home`: auth, visibility, kids, cache invalidation, partial failure
- Gateway: the bitrate clamp respects the remote cap.
- Web unit:
  - `bandwidth.ts` (EWMA, outliers, persistence)
  - `abr.ts` (stall/step-down/step-up/cooldown/manual pin)
  - gestures and keymap additions
- e2e:
  - throttled/stalling media route: the player steps down and keeps playing at the same position
  - quality chip and reason
  - phone gestures (double-tap seek, lock)
  - PC shortcuts
  - home first paint with ≤ 5 API calls
  - TV mode regression
- All checks plus the full e2e suite; then the same in the Plex fork after the port.

## Seam impact (Plex fork)

- `PlaybackInfoDto.transcodeReason?` is additive and optional. The Plex fork maps it from its decision
  response.
- The remote cap and `/api/home` are server-agnostic and go through the existing MediaServer methods.
- The fork port happens after the upstream merge.
