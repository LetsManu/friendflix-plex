# Block 20 – Smooth streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remote playback that adapts to the viewer's connection instead of buffering or aborting; comfortable phone and PC player controls; a home page that appears with a handful of requests.

**Architecture:**
- The web player estimates throughput, picks a rung of the existing quality ladder under it and steps down on stalls and errors. Two pure modules (`bandwidth.ts`, `abr.ts`) do this, wired into `Player.svelte`.
- The backend adds a server-enforced per-role remote bitrate cap. Home networks are given as CIDRs and resolved from the real client IP; the gateway passes that IP to `/internal/authz`.
- The backend also adds a `transcodeReason` to the playback DTO and a new aggregated `GET /api/home`.

**Tech Stack:** Fastify + zod + Postgres (backend), node gateway, SvelteKit (legacy syntax) + hls.js (web), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-12-block20-smooth-streaming-design.md`

## Global Constraints

- Quality ladder: Original, then 1080p 8 Mbit/s, 720p 4 Mbit/s, 480p 1.5 Mbit/s, 360p 0.8 Mbit/s (the existing `QUALITIES` plus Original).
- Auto rung: the highest one ≤ estimate × 0.7 and ≤ the effective cap. With no estimate, start at 720p / 4 Mbit/s.
- Direct play only if source bitrate ≤ estimate × 0.7 (on top of the existing checks).
- Stall step-down: a `waiting` longer than 2 s, or 3 stalls within 60 s. Step-down cooldown is 10 s; the floor is 360p.
- Network errors: step down after the first failed retry. Only fail at the floor.
- Step-up: at most once per 60 s, and only if the estimate has been ≥ the next rung ÷ 0.6 for 30 s and the buffer is ≥ 20 s.
- hls.js: `maxBufferLength 60`, `maxMaxBufferLength 120`, `backBufferLength 90`, plus explicit fragment and manifest load policies with more retries.
- Bandwidth estimate: stored in `localStorage` key `ff_bw` with a timestamp and ignored after 7 days.
- Remote cap: `remoteMaxBitrate` per role, default 8 Mbit/s for friend and family (owner upload 33 Mbit/s). Defaults for the other roles:
  - guest: 4 Mbit/s
  - admin: 12 Mbit/s

  `HOME_NETWORKS` is a CIDR list defaulting to RFC1918 + loopback + fc00::/7 + fe80::/10. Ambiguous or unknown IPs count as remote.
- `/api/home`:
  - server cache TTL 60 s per profile plus the userDataVersion
  - a failing part returns empty plus a flag, never 500
  - old endpoints stay
- Keep TV mode unchanged. All new UI text goes in all 7 locales (de source). No new npm dependencies. No other brands' look-alikes (Block 19 rules).
- Builds and e2e run under `flock`. Processes are killed by PID only.

## Review Focus

1. **Spoofed X-Forwarded-For from an untrusted hop** must not unlock the home cap. Test in Task 3.
2. **Quality switch while paused or seeking:** the position and audio/subtitle choice are kept, and no double transcode session is left running. Test in Task 5.
3. **Manual quality pinned:** no auto step-up, but a step-down still happens on a fatal stall, with a toast. Test in Task 2 plus e2e in Task 5.
4. **A cached authz for one IP must not leak a home cap to the same sid from another IP.** Test in Task 3 (gateway cache key).
5. **`/api/home` for a kids profile** must not contain titles above the age cap or social parts. Test in Task 7.

---

### Task 1: Bandwidth estimator (web)

**Files:**
- Create: `web/src/lib/player/bandwidth.ts`
- Test: `web/src/lib/player/bandwidth.test.ts`

**Interfaces:**
- Produces:
  - `class BandwidthEstimator { constructor(o?: { alpha?: number; minBytes?: number }); add(bytes: number, ms: number): void; get estimate(): number | null /* bit/s */; get samples(): number }`
  - `loadStoredEstimate(now?: number): number | null`
  - `storeEstimate(bps: number, now?: number): void` (key `ff_bw`, JSON `{ bps, at }`, 7-day expiry)

- [ ] **Step 1: Write failing tests:**
  - `ignores samples under minBytes (default 64 KiB)`
  - `ewma converges: add(1_000_000 B, 1000 ms) x5 → estimate ≈ 8_000_000 ±5%`
  - `one 10x outlier moves the estimate < 30 %`
  - `store/load roundtrip; load returns null after 7 days and on corrupt JSON`
- [ ] **Step 2:** `npx -w web vitest run src/lib/player/bandwidth` → FAIL (module missing).
- [ ] **Step 3:** Implement: EWMA with alpha 0.3, where each sample's influence is capped at 3× the current estimate (outlier damping). Wrap storage in try/catch.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** `git commit -m "feat(player): bandwidth estimator"`

### Task 2: ABR decision logic (web)

**Files:**
- Create: `web/src/lib/player/abr.ts`
- Test: `web/src/lib/player/abr.test.ts`

**Interfaces:**
- Consumes: estimates (bit/s) from Task 1.
- Produces:
  - `export const LADDER: Array<{ key: 'original'|'1080p'|'720p'|'480p'|'360p'; bps: number }>` (original bps = Infinity)
  - `pickRung(estimate: number | null, cap: number, sourceBps?: number): number` returns bps; 0 never
  - `class AbrController { constructor(o: { now: () => number; cap: number; pinned?: number }); onStall(ms: number): Decision; onNetworkError(): Decision; onTick(s: { estimate: number | null; bufferSec: number }): Decision; get current(): number }`
  - `type Decision = { do: 'none' } | { do: 'switch'; bps: number; reason: 'stall'|'network'|'up' } | { do: 'fail' }`

- [ ] **Step 1: Write failing tests:**
  - `pickRung(null, 20e6) → 4e6`
  - `pickRung(10e6, 20e6) → 4e6` (10 × 0.7 = 7 < 8)
  - `pickRung(13e6, 20e6) → 8e6`
  - `pickRung(100e6, 20e6, 15e6) → Infinity` (original fits under estimate × 0.7 and cap)
  - `pickRung(100e6, 8e6, 15e6) → 8e6` (cap wins)
  - stall rules:
    - `stall 2.5 s → switch down one rung, reason stall`
    - `3 stalls of 1 s in 60 s → switch down`
    - `second step-down within 10 s → none`
    - `at 360p a stall → fail`
  - `network error → switch down; at floor → fail`
  - `step-up only after 30 s of estimate ≥ next/0.6 and buffer ≥ 20 s, max once per 60 s`
  - `pinned: onTick never steps up; onStall still steps down`
- [ ] **Step 2:** `npx -w web vitest run src/lib/player/abr` → FAIL.
- [ ] **Step 3:** Implement as a pure class driven by the injected `now()`, with no DOM.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** `git commit -m "feat(player): ABR decision logic"`

### Task 3: Remote bitrate cap (backend + gateway)

**Files:**
- Create: `backend/src/netaddr.ts` (`isHomeAddress(ip: string, cidrs: string[]): boolean`, IPv4 + IPv6 + IPv4-mapped IPv6)
- Modify:
  - `backend/src/roles.ts`: add `remoteMaxBitrate` to the schema, `DEFAULT_ROLES` and `effectiveRole` (role_settings override)
  - `backend/src/db.ts`: migration 34, `alter table role_settings add column remote_max_bitrate int check (remote_max_bitrate between 300000 and 200000000)`
  - `backend/src/config.ts`: `HOME_NETWORKS` (comma-separated CIDRs, default as in Global Constraints)
  - `backend/src/routes/media.ts` (`POST /api/playback/info`): `cap = min(role cap, remote ? remoteMaxBitrate : ∞, client maxBitrate)` using `req.ip` (Fastify trustProxy already on)
  - `backend/src/routes/internal.ts` (`/internal/authz`): accept an optional `ip` in the body; return `maxBitrate` already lowered for remote IPs
  - `gateway/src/gateway.ts`: send `ip: clientKey(req)` in the `/internal/authz` body; the auth cache key becomes `sid + '|' + ip`
  - admin roles API + page `web/src/routes/admin/roles/+page.svelte`: a "Limit unterwegs" Select (2/4/8/12/20/40 Mbit/s), i18n `adminPeople` in 7 languages
  - `docs/operations.md`: explain `HOME_NETWORKS` and the remote limit
- Test:
  - `backend/test/remote-cap.test.ts`
  - `backend/test/netaddr.test.ts` (or unit in the same file)
  - `gateway/test/` new case

**Interfaces:**
- Produces:
  - `RoleTemplate.remoteMaxBitrate: number`
  - `isHomeAddress(ip, cidrs)`
  - authz response `maxBitrate` reflects the remote cap

- [ ] **Step 1: Write failing tests:**
  - netaddr:
    - `10.1.2.3, 192.168.0.5, 127.0.0.1, ::1, fd00::1, ::ffff:192.168.1.2 → home`
    - `8.8.8.8, 2001:db8::1, '', 'unknown' → remote`
  - remote cap:
    - `playback/info from 203.0.113.9 (friend) → maxBitrate = 4_000_000`
    - `from 192.168.1.10 → 20_000_000`
    - `X-Forwarded-For: 192.168.1.10 sent by an untrusted direct peer is ignored` (configure the test app's trustProxy like prod)
    - `role_settings.remote_max_bitrate overrides the default`
  - internal authz: `ip 203.0.113.9 → maxBitrate 4e6; ip 192.168.1.10 → 20e6`
  - gateway: `two requests, same sid, different ip → two authz calls (cache key includes ip)`, and the bitrate query param is clamped to the returned maxBitrate
- [ ] **Step 2:** Run the backend suite on the new files (`TEST_DATABASE_URL=… npx -w backend vitest run test/remote-cap test/netaddr`) and `npm test -w gateway` → FAIL.
- [ ] **Step 3:** Implement the files listed above.
- [ ] **Step 4:** Re-run both → PASS. Also run the full backend suite, gateway tests and the admin-people e2e.
- [ ] **Step 5:** `git commit -m "feat: per-role remote bitrate cap (home networks by CIDR)"`

### Task 4: Transcode reason in playback info (seam)

**Files:**
- Modify:
  - `backend/src/media/types.ts`: add `PlaybackDto.transcodeReason?: 'network' | 'remoteCap' | 'roleCap' | 'container' | 'videoCodec' | 'audioCodec' | 'audioTrack' | 'subtitles' | 'height' | 'manual' | 'other'` (optional, documented)
  - `backend/src/jellyfin/dto.ts` (`toPlaybackDto`): when not direct, map Jellyfin `TranscodeReasons` (from `TranscodingUrl` query) plus our caps; `audioIndex` set → `audioTrack`
  - `backend/src/routes/media.ts`: when the remote cap or role cap lowered `cap` below the source bitrate, the reason is `remoteCap`/`roleCap`; a client `maxBitrate` below the role cap is `manual` or `network`. The client sends `reasonHint: 'network' | 'manual'` (zod enum, optional).
  - `docs/architecture.md`: seam table row
- Test: `backend/test/media-seam.test.ts` (extend)

- [ ] **Step 1: Write failing tests:**
  - `ContainerNotSupported → container`
  - `AudioCodecNotSupported → audioCodec`
  - `remote IP with cap below source bitrate → remoteCap`
  - `direct play → transcodeReason undefined`
  - `reasonHint network passes through when it is the binding cap`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the mapping table in `dto.ts`; unknown values → `other`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** `git commit -m "feat(seam): transcodeReason on playback info"`

### Task 5: Player integration – auto quality, stall handling, reason chip

**Files:**
- Modify:
  - `web/src/lib/Player.svelte`: wire in Tasks 1 and 2:
    - hls.js `FRAG_LOADED` stats → estimator; direct play → progress bytes
    - `waiting`/`playing` timing → `onStall`
    - network fatal → `onNetworkError` replaces the current 3-retry give-up path for network errors; media errors keep `retry.ts`
    - a 5 s timer → `onTick`
    - quality 0 = auto: `pickRung` sends `maxBitrate` + `reasonHint`
    - a manual pick sets `pinned`
    - a switch reuses `changeQuality` (position + tracks kept, old session stopped)
  - `web/src/lib/player/hls.ts` (`hlsConfig`): buffer values and load policies from Global Constraints
  - new `web/src/lib/player/QualityChip.svelte`: shows "Original" or "Umgewandelt · 720p" and opens the reason; it sits in the control bar near the time
  - i18n `player` area in 7 languages: chip labels, reason texts, toasts ("Leitung langsam – 480p", "Qualität fest: 1080p")
- Test:
  - `web/src/lib/player/hls.test.ts` (config values)
  - `e2e/tests/player-abr.spec.ts`: mock `/api/playback/info` and a media route that stalls (delayed chunks):
    - `auto steps down after a stall and keeps the position (±2 s)`
    - `chip shows Umgewandelt · 720p and reason Leitung langsam`
    - `manual 1080p is pinned: no step-up, step-down on stall shows toast`
    - `playback/info called with maxBitrate 4_000_000 when no stored estimate`
    - `pause, then switch quality → still paused, same audio track` (Review Focus 2)

- [ ] **Step 1:** Write the e2e spec and the hls config test → FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Locked build, then run `player-abr`, `player-scenes`, `player-tracks` and the TV specs → PASS.
- [ ] **Step 4:** `git commit -m "feat(player): adaptive quality with stall recovery and reason chip"`

### Task 6: Player controls – fill the gaps (phone + PC)

Double-tap seek, swipe volume/brightness/scrub and lock already exist (`gestures.ts`, `Player.svelte` ~646-720) and are not rebuilt.

**Files:**
- Modify:
  - `web/src/lib/player/keymap.ts`:
    - new actions `{ type: 'speed'; delta: 1 | -1 }` for `<`/`>` (also `,`/`.` with shift on some layouts)
    - keep TV branch unchanged
  - `web/src/lib/Player.svelte`:
    - execute `speed`
    - wheel over the video changes volume by ±0.05 (desktop only, ignored while a menu is open; `passive: false` only on the stage)
    - double-click toggles fullscreen (desktop)
    - outside click and Esc close menus with focus back on the opener
    - on phones, after fullscreen try `screen.orientation.lock('landscape')` and ignore failure
    - main-bar touch targets ≥ 48 px on coarse pointers; on coarse pointers move speed and scenes into "More"
  - `SHORTCUTS` + i18n help texts (7 languages)
- Test:
  - `web/src/lib/player/keymap.test.ts`:
    - `< → speed -1`
    - `> → speed +1`
    - `tv: < → null`
  - e2e `e2e/tests/player-controls.spec.ts`:
    - `wheel down lowers volume`
    - `dblclick toggles fullscreen`
    - `click outside closes the tracks menu and focus returns`
    - `> raises speed and shows feedback`
  - e2e `e2e/tests/player-controls.mobile.spec.ts`: `main bar buttons ≥ 48 px; speed reachable via More`

- [ ] **Step 1:** Write the tests → FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Locked build, then run the new specs plus `player-scenes*` and the TV specs → PASS.
- [ ] **Step 4:** `git commit -m "feat(player): speed keys, wheel volume, dblclick fullscreen, menu outside-click, phone layout"`

### Task 7: Aggregated home endpoint

**Files:**
- Create: `backend/src/routes/home.ts`, which registers `GET /api/home`
  - It calls the same internal functions the current endpoints use (hero items, resume, next up, leaving, recommendations, because rows, hubs, themed lists). Factor them out of their route handlers only where needed, without changing those responses.
  - Response shape: `{ parts: { hero, resume, nextup, leaving, recs, because, hubs, themed }, failed: string[] }`
  - Cache: kv, key `home:<profileId>:<userDataVersion>`, TTL 60 s
- Modify:
  - `backend/src/app.ts` (register)
  - `web/src/routes/+page.svelte` + `web/src/lib/home.ts`: the first screen comes from `/api/home` through `swrLoad(homeCache, …)`; fall back to the old per-row loaders for any name in `failed`; idle and scroll rows unchanged; the first visible row's images get `fetchpriority="high"`
  - `docs/architecture.md` (endpoint list)
- Test:
  - `backend/test/home.test.ts`:
    - `401 without session`
    - `parts present for a normal profile`
    - `kids profile: no item above cap, no social/because-from-friends parts` (Review Focus 5)
    - `one failing part → 200 with failed:['x']`
    - `watched change bumps userDataVersion → fresh data`
  - e2e `e2e/tests/home-fast.spec.ts`: count `/api/` requests until the first row is visible ≤ 5 (excluding `/api/me`, notifications, prefs); the page renders when `/api/home` returns `failed:['recs']`

- [ ] **Step 1:** Write the tests → FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run the backend suite, then a locked build plus the full e2e → PASS.
- [ ] **Step 4:** `git commit -m "feat: aggregated /api/home for the first screen"`

### Task 9: Smooth transition into the player (runs after Task 6, before Task 8)

Owner request, approved in chat on 2026-10-12. What exists today:
- `web/src/lib/player/prefetch.ts` (`prefetchPlayer()`) warms only the /watch route code and hls.js.
- `web/src/routes/+layout.svelte:247-260` runs a 180 ms crossfade view transition but skips it for /watch and /party (`immersive`).

**Files:**
- Modify:
  - `web/src/lib/player/prefetch.ts`: add `prefetchPlayback(itemId: string): void`. On hover, focus or touchstart of a play control it POSTs `/api/playback/info` with the same body the player would send (Task 5 auto maxBitrate and reasonHint) and keeps the promise in a module map for 30 s.
    - Add `takePrefetched(itemId: string, body: object): Promise<PlaybackDto> | null`, which returns it once and only if the body matches.
    - On a 429 or any error the entry is dropped silently; the player then fetches normally.
    - At most one item is in flight. A new hover replaces the old entry.
  - Every play control that already calls `prefetchPlayer` also calls `prefetchPlayback(id)`. Grep the call sites (Hero, DetailView, Card/HoverPreview, EpisodeList and others).
  - `web/src/lib/Player.svelte`:
    - Consume `takePrefetched` before calling the API.
    - Show the item's backdrop (or primary image) as a full-bleed, dimmed poster with the title and a thin progress bar from the first frame of the route.
    - Crossfade the poster out over 300 ms on the first `playing`/`loadeddata` event.
    - Keep the control bar hidden until playback starts.
    - Never flash white or black. The stage background is the poster colour (`--bg`).
  - `web/src/routes/+layout.svelte`:
    - Enable a dedicated transition into and out of `/watch/` instead of skipping it. The clicked artwork carries `view-transition-name: ff-play-art`, set on the clicked element only, just for the transition. It morphs into the player poster, which has the same name.
    - Fallback, when the API is missing or the element is gone: a 200 ms fade.
    - Reduced motion: an instant cut plus a 120 ms fade.
    - TV: unchanged (no transition).
    - Leaving the player restores the previous page's scroll position. This is the SvelteKit default; verify it, and fix it if the immersive route breaks it.
  - `app.css`: the `::view-transition-*` rules for `ff-play-art`, with no layout shift and the header hidden during the transition.
- Test:
  - `web/src/lib/player/prefetch.test.ts`:
    - `takePrefetched returns the promise once`
    - `expired after 30 s`
    - `body mismatch → null`
    - `error drops the entry`
  - e2e `e2e/tests/player-transition.spec.ts`:
    - `hover on Abspielen triggers one /api/playback/info before the click`
    - `the click navigates without a second playback/info call (the prefetch is used)`
    - `the player shows the backdrop poster with the title before the first frame (no blank stage: screenshot pixel check on the stage is not uniform black or white)`
    - `the poster fades out once playing`
    - `back restores the scroll position of the home page`
    - `reduced motion: no view transition class is set`
  - Measure the time from the click to the first frame, before and after; report it in the PR.

- [ ] **Step 1:** Write the unit and e2e tests → FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Locked build, then run the new specs plus `player-*`, `home-*` and the TV specs → PASS.
- [ ] **Step 4:** `git commit -m "feat(player): smooth transition into the player (prefetched playback info, poster, view transition)"`

### Task 8: Final verification and docs

- [ ] Run lint, typecheck, web, gateway and the full backend suite, then the locked web build and the full e2e. Everything must be green; record the counts.
- [ ] Measure home first paint before and after: request count and time to first row, from the e2e run.
- [ ] Docs:
  - `docs/operations.md`: remote limit + `HOME_NETWORKS`
  - CHANGELOG entry
  - README feature line (EN + DE)
- [ ] Run gitleaks on the branch (check the exit code directly).
- [ ] Open the PR; after the merge, port to the Plex fork (map `transcodeReason` from the Plex decision; the remote cap and `/api/home` come in through the merge).
