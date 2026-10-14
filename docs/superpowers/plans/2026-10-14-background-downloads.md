# Background Downloads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Downloads continue in the background on Android (Background Fetch) and resume at once on iPhone after the
app was hidden, instead of sitting on "Warten".

**Architecture:** Page module `lib/offline/bgfetch.ts` wraps Background Fetch. The service worker module
`lib/sw/bgfetch.ts` stores finished fetches into OPFS and updates IndexedDB. `manager.ts` picks Background Fetch or
the worker per record and pauses or resumes the worker on visibility changes.

**Tech Stack:** SvelteKit, TypeScript, Vitest, Playwright, OPFS, IndexedDB, Background Fetch API.

**Spec:** `docs/superpowers/specs/2026-10-14-background-downloads-design.md`

## Global Constraints

- Background Fetch id format: `ff-dl-<downloadId>`.
- Quota check for Background Fetch: `2 × bytesTotal`.
- New i18n keys in all 7 locales: `account.downloads.msg.background`, `account.downloads.iosKeepOpen`,
  `account.downloads.bgDone` (service worker notification title, `{title}` placeholder).
- No gateway or backend changes. No new dependencies.
- Code style: match the surrounding files (dense one-line helpers, short comments).

## Review Focus

1. Page closed while the service worker finishes: the next open must show `done` (record re-read, not overwritten by
   stale in-memory state).
2. The service worker cannot write OPFS: the download must not end as "done" with an empty file.
3. iOS hidden mid-download: no data lost, resume uses Range from the flushed `bytesHave`.
4. Pause on Android restarts from zero: `bytesHave` must be 0 so the size check does not fail.
5. Revoke or remove during a background fetch: the registration is aborted before the files are deleted.

---

### Task 1: iOS / no-Background-Fetch: pause on hidden, resume at once

**Files:** Modify `web/src/lib/offline/manager.ts`, `web/src/routes/downloads/+page.svelte`, the 7 locale files;
Test `web/src/lib/offline/manager.test.ts`, `e2e/tests/downloads*.spec.ts` (existing downloads spec).

- [ ] Tests:
  - `hidden pauses the running worker and shows the background message`: the worker reports `paused`, the state is
    `queued`, `msg` is `tr('account.downloads.msg.background')`.
  - `visible resumes at once without back-off`: `retryAt` is cleared and the worker starts with `have` = the stored
    `bytesHave`.
  - `network error while hidden uses the background message without back-off`.
- [ ] Implement: a `hiddenPause` flag in the manager, set on hidden or `pagehide` when `running` and the run is not
  via Background Fetch. The worker `paused` message with `hiddenPause` set gives `queued` + `msg.background`. Visible:
  clear `retryAt`, reset the flag, `poll()`. A network error within 2 s of a visible change also counts as a
  background pause.
- [ ] Downloads page: iOS note (`isIos` helper exported from `opfs.ts`) with `account.downloads.iosKeepOpen`.
- [ ] e2e: dispatch hidden then visible via `page.evaluate` (override `document.visibilityState`). The state text
  shows the background message, then "done".
- [ ] Run `npm test -w web`, `npm run check -w web`, `npm run lint`. Commit.

### Task 2: Background Fetch page module + manager integration

**Files:** Create `web/src/lib/offline/bgfetch.ts` and its test; Modify `db.ts` (optional fields `via`, `noBg`,
`readyUrl`, `extrasPending`), `manager.ts`, `fetch-worker.ts` (extras-only start: `extrasOnly?: boolean` in
`StartMsg`, posts `done` with the current file size and no video fetch).

**Interfaces (produces):**
- `bgSupported(): Promise<boolean>`
- `startBg(id: string, url: string, opts: { title: string; total: number; icon?: string }): Promise<'started' | 'running' | 'failed'>`
- `watchBg(id: string, onProgress: (downloaded: number) => void): Promise<boolean>` (false: no registration)
- `abortBg(id: string): Promise<void>`
- `bgTag(id) => 'ff-dl-' + id`

- [ ] Tests (fakes for `navigator.serviceWorker.ready.backgroundFetch`):
  - start sets `via: 'bg'`
  - a throw gives `noBg` and the worker start
  - `running` reattaches
  - progress updates `bytesHave`
  - pause aborts and sets `bytesHave: 0`
  - remove or revoke aborts before the files are deleted
  - init with `via: 'bg'` and no registration re-reads IndexedDB
  - `done` + `extrasPending` runs the extras-only worker and clears the flag
  - `applyServer` with `ready` stores `readyUrl`
  - the quota check uses 2×
- [ ] Implement in the manager: in `pump()`/`startWorker`, pick Background Fetch when `await bgSupported()` and
  `!v.noBg`. Keep `running` single-slot semantics (a Background Fetch run occupies `running`). The hidden pause from
  Task 1 is skipped for `via: 'bg'`.
- [ ] Run checks. Commit.

### Task 3: Service worker handlers

**Files:** Create `web/src/lib/sw/bgfetch.ts` (+ test); Modify `web/src/service-worker/index.ts` (call
`installBgFetch(sw)`).

**Interfaces:** `installBgFetch(sw: ServiceWorkerGlobalScope): void`; exported pure helpers for tests:
`onSuccess(ev, deps)`, `onFail(ev, deps)`, `onAbort(ev, deps)`, `nextToChain(records, done): DownloadRecord | undefined`.

- [ ] Tests:
  - success streams into the OPFS writable, sets the record to `done` with size, `extrasPending`, posts `/fetched`,
    and calls `updateUI` with the translated title
  - a writable missing or throwing sets `queued`, `bytesHave: 0`, `noBg`
  - fail sets `noBg`, `bytesHave: 0`
  - abort with the record still `downloading` sets `paused`
  - `nextToChain` picks only the same profile, `queued`, `readyUrl`, not `noBg`
  - click opens `/downloads`
- [ ] Implement with the `db.ts` functions (they work in the service worker). The language comes from `offlineLocale()`
  and a small inline map for `bgDone` (the service worker has no i18n runtime). Copy the 7 strings from the locale
  files.
- [ ] Run checks and the web build (`npm run build -w web`). Commit.

### Task 4: Docs

- [ ] README downloads line and `docs/` downloads section: Android background, iPhone note. Add a CHANGELOG entry.
  Commit.
