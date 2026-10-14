# Background downloads on phones (design)

Date: 2026-10-14 · Status: approved in chat ("ja gut")

## Goal

Downloads keep going when the app goes to the background on a phone, where the platform allows it, and never sit on
"Warten" after the user comes back.

Owner decision: both platforms.
- **Android (Chromium: Chrome, Edge, Samsung Internet):** a real background download through the Background Fetch API
  with the system progress notification. It keeps running with the app closed or the screen locked.
- **iPhone (WebKit):** no web app can download in the background (iOS suspends the page). The download pauses cleanly
  when the app is hidden and continues at the same byte at once when it is visible again, with a clear text.

Not in scope: native app wrapper, Firefox background downloads (keeps today's path), changes to the gateway or backend.

## Why it fails today

`manager.ts` runs one dedicated worker (`fetch-worker.ts`) that streams `/media/d/<id>` into OPFS with Range resume.
When the phone hides the page, the fetch dies. The worker reports `network`, the manager sets `queued` with the
"network" message and a 15 s back-off (`retryAt`). The UI shows "Warten". On iOS the page is often frozen
with the worker killed and no error at all, so the record stays in that state until the next poll after the back-off.

## Android: Background Fetch

### Page side (`web/src/lib/offline/bgfetch.ts`, new)

- `bgSupported()`: true when `navigator.serviceWorker` is ready and its registration has `backgroundFetch`.
- When the manager would start the worker for a record and `bgSupported()` and the record has no `noBg` flag, it
  calls `backgroundFetch.fetch('ff-dl-<id>', ['/media/d/<id>'], { title, icons, downloadTotal: bytesTotal })` instead.
  The record gets `via: 'bg'`, state `downloading`, `bytesHave: 0`.
- Progress: the page listens to the registration's `progress` event and sets `bytesHave = downloaded`.
- Page reload or reopen: for each record with `via: 'bg'` and state `downloading`, the manager looks up
  `backgroundFetch.get('ff-dl-<id>')`. If found, it reattaches. If missing, it re-reads the record from IndexedDB,
  because the service worker may have finished or failed it while the page was closed.
- `fetch()` throws (permission denied, quota, unsupported request): set `noBg: true` and use the worker path.
- Pause: `registration.abort()`, then state `paused`, `bytesHave: 0`. Background Fetch has no Range resume, so a
  paused Android download restarts from zero. Resume uses Background Fetch again.
- Remove or revoke: abort the registration first, then today's cleanup.
- Quota check before start: needs `2 × bytesTotal`, because the finished file is copied once.

### Service worker side (`web/src/lib/sw/bgfetch.ts`, new, installed from `service-worker/index.ts`)

- `backgroundfetchsuccess`: inside `event.waitUntil`:
  1. Stream the single record's response into OPFS `ff-dl/<id>/video.mp4` with `createWritable()`.
  2. Update the IndexedDB record: state `done`, `bytesHave = bytesTotal = size`, `via` removed, `extrasPending: true`.
  3. Call `POST /api/downloads/<id>/fetched` (best effort).
  4. Call `event.updateUI({ title: <done text> })`.
  5. Start the next record (same `profileId`, state `queued`, `readyUrl` set, no `noBg`) with Background Fetch, best
     effort.
  - If OPFS writing fails (no `createWritable` in this service worker), set state `queued`, `bytesHave: 0`, and
    `noBg: true`. The page then downloads it again with the worker path when opened. This path is also unit-tested.
- `backgroundfetchfail`: state `queued`, `bytesHave: 0`, `via` removed, `noBg: true` (the worker path with Range
  takes over when the app is opened).
- `backgroundfetchabort`: nothing, because the page that aborted already wrote the state. If no page aborted it (the
  user cancelled in the notification), state `paused`.
- `backgroundfetchclick`: focus an open window or open `/downloads`.
- The page sets `readyUrl` in the record when the server reports the licence `ready` (the `fileUrl`), so the service
  worker can chain without the API.
- Texts in the service worker: the done title uses the language stored by `offlineLocale()` (same as the offline hub),
  falling back to German.

### Extras

Subtitles, poster and backdrop are small and come later. When the manager sees `done` with `extrasPending`, it runs
the worker in extras-only mode and then clears the flag. Offline playback works before that; only subtitles and
pictures are missing until then.

## iPhone (and every browser without Background Fetch)

- On `visibilitychange` to hidden, and on `pagehide`, the manager tells the running worker to pause.
  The worker flushes and reports `paused`. The manager stores state `queued` with the new message
  `msg.background` ("Pausiert – läuft weiter, sobald FriendFlix offen ist") and a `bgPaused` marker (volatile).
- On visible: clear `retryAt` for all records, run `poll()` and `pump()` at once. The download continues from
  `bytesHave` with Range.
- A `network` error while the page is hidden (or within 2 s after it became visible) is treated the same way: no
  back-off, `msg.background`.
- Downloads page: on iOS a one-line note under the storage bar, `downloads.iosKeepOpen` ("Auf dem iPhone die App beim
  Laden offen lassen – im Hintergrund pausiert iOS den Download.").
- On Android with Background Fetch the hidden handler does nothing (the browser keeps downloading).

## Data

`DownloadRecord` gets optional fields (no DB version change, IndexedDB stores whole objects):
`via?: 'bg'`, `noBg?: boolean`, `readyUrl?: string`, `extrasPending?: boolean`.

## Error handling

- Session ends during a background download: the gateway checks the cookie only at the request start, so a running
  fetch continues. A failure later goes the `backgroundfetchfail` path.
- Licence revoked while a background download runs: `checkIn()` aborts the registration, then expires the record.
- Two tabs: the Background Fetch id is unique per download, and a second `fetch()` with the same id rejects.
  The manager treats that as "already running" and reattaches.

## Testing

- Unit (Vitest):
  - `bgfetch.ts`: start, progress, reattach, the fallback on throw, pause and abort.
  - Service worker handlers with fakes for the registration, records, OPFS and IndexedDB: success writes the file and
    the record, a write failure goes to `noBg`, fail and abort, chaining picks the right next record.
  - Manager: the hidden/visible pause and immediate resume, network-while-hidden without back-off, and no hidden pause
    when the download runs via Background Fetch.
- e2e (Playwright, desktop Chromium): start a download, emulate `visibilitychange` hidden then visible. The state text
  shows the background message, then the download completes. The Background Fetch path is covered by unit tests only,
  because headless Chromium has no Background Fetch UI.
- Coverage thresholds must hold. All new strings in all 7 languages.
- Manual: Android phone with Chrome (lock the screen mid-download), iPhone PWA (switch apps, come back).
