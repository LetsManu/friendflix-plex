# UI kit (`web/src/lib/ui`) and admin shell (`web/src/lib/admin`)

One set of building blocks for consumer and admin pages. Everything uses the tokens in `app.css` (`--surface`, `--line`,
`--ok/--warn/--err/--info` and their `--tone-*` backgrounds, `--danger`), the `Icon` set, 44px touch targets, the global
focus ring (TV: bigger ring) and respects `prefers-reduced-motion` (CSS rule in `app.css`; Svelte transitions use
`dur()` from `ui/motion.ts`). All texts come from the i18n area `ui` (7 languages).

## Colour tokens

Defined in `web/src/app.css`; components prefer the tokens; one-off shades only for gradients and overlays.

| Token | Value | Use |
|---|---|---|
| `--bg` / `--bg-deep` | `#101418` / `#000` | page background (blue-black) / player and intro |
| `--surface`, `--card` | `#161b21` | panels, cards, menus |
| `--surface-2` | `#242b33` | raised surfaces, badges, inputs hover |
| `--line` | `#2a323b` | borders and dividers |
| `--fg` / `--mut` | `#f5f5f5` / `#b3bac2` | text / secondary text (9:1 on `--bg`) |
| `--acc` | `#ff4f6d` (coral) | accent for text, rings, progress bars, focus glow (5.8:1 on `--bg`) |
| `--acc-hover` | `#e63e5c` | hover for accent-coloured text and links |
| `--acc-fill`, `--acc-fill-hover` | `#d6325a`, `#c9304d` | **filled** buttons and badges that carry white text |

Contrast decision: white text on plain coral `#ff4f6d` is only 3.2:1, below the 4.5:1 needed for small text. Filled surfaces
therefore use the darker coral `--acc-fill` (white on it: 4.7:1, hover 5.2:1); the lighter coral stays for text and graphics
on dark surfaces (3:1 is enough for non-text, and 5.8:1 for text). The logo tile is a coral gradient `#ff6b81` to `#e23c5b`.

## Rules

- **Every mutation** goes through `runAction` (busy flag per row, optimistic change + rollback, toast).
- **Irreversible** actions ask first with `confirm({ danger: true })`; *very* destructive ones add `typed: '<name>'`.
- **Reversible or postponable** actions do not ask: they show a toast with **Undo** (`undo.run` = inverse call, or
  `defer: true` = commit only after the toast is gone).
- **Never** `alert()` / `confirm()` / inline `msg` lines for action feedback.
- **Every list** has four states: skeleton, empty, error + retry, content (`DataTable` does this for you).
- State is never colour alone: `StatusPill` always has icon + text.

## Feedback

```ts
import { toast } from '#lib/ui/toast';
toast.success(tr('…saved'));
toast.error(errorText(e), { action: { label: tr('ui.retry'), run: save } });
toast.info(msg, { duration: 0, key: 'sync' });   // sticky; same key replaces instead of stacking
```
`ToastHost` (mounted once in `routes/+layout.svelte`) is a polite live region, max 3 toasts, timers pause on hover/focus,
Escape closes the focused toast, sits above the phone tab bar. Defaults: 5 s, errors 8 s, with an action 6 s.

```ts
import { confirm } from '#lib/ui/confirm';
if (!(await confirm({ title: tr('…confirmDelete', { name }), body?, danger: true, confirmLabel: tr('…delete') }))) return;
await confirm({ title, danger: true, typed: user.name });   // button enabled after typing the name
```
Modal `alertdialog`, focus trap (`dialogKeys`), Escape/backdrop = cancel, focus starts on Cancel for danger, returns to
the trigger. Requests queue; without a mounted host it resolves `false`.

```ts
import { runAction, busyKeys, errorText } from '#lib/ui/action';
await runAction({
  key: `user:${u.id}`,                          // $busyKeys.has(key) → row spinner; double clicks are skipped
  apply: () => { const prev = u.disabled; u.disabled = true; users = users; return () => { u.disabled = prev; users = users; }; },
  run: () => api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { disabled: true } }),
  success: tr('…locked', { name: u.name }),     // string | (result) => string
  undo: { run: () => api(…, { body: { disabled: false } }) },   // optional Undo in the toast
  // defer: true,                               // delay-commit instead (run() after the toast closes, Undo = rollback)
  //                                            // leaving the page commits at once: root layout beforeNavigate (route change,
  //                                            // reload) + pagehide → flushDeferred(); on unload the requests use keepalive
  // error: false | string | (e) => string      // default errorText(e): 403/404/409/429/5xx/offline texts
}); // → { ok, value?, error?, undone?, skipped? }
```

## Components

| Component | Props (main) | Notes |
| --- | --- | --- |
| `Button` | `variant` primary/secondary/ghost/danger, `pending`, `icon`, `size` md/sm, `href`, `block`, `solid` | pending = spinner + `aria-busy`, keeps focus, swallows clicks |
| `DataTable` | `rows` (null = loading), `columns`, `key`, `caption`, `filterable`, `pageSize` (25, 0 = off), `actions(row)`, `rowLabel(row)`, `busyKey(row)` (runAction key; the table follows `busyKeys` itself), `busy(row)` (custom test), `error` + `on:retry`, `emptyText`, bind `q`/`sort`/`page`; server paging: `total` + `on:query` ({ q, sort, offset, limit }) | sticky header, `aria-sort`, cards at ≤720px (mark one column `primary`), slots `cell` (let:row let:col), `toolbar`, `empty` |
| `Column<T>` (`ui/table.ts`) | `key`, `label`, `value(row)`, `sortable`, `sort(a,b)`, `filter: false`, `align`, `width`, `primary`, `hideOnCard` | |
| `ActionMenu` | `items: MoreAction[]` ({ id, label, icon, run, href, danger, disabled }), `label`, `title`, `busy` | popover / bottom sheet (MoreActions) |
| `StatusPill` | `tone` ok/warn/err/info/muted, `label`, `icon` | |
| `StatTile` | `label`, `value` (null = skeleton), `icon`, `hint`, `href`, `tone` | value is not a heading |
| `Skeleton` | `w`, `h`, `radius`, `lines`, `inline` | |
| `Progress` | `value` (null = indeterminate), `max`, `label`, `showValue`, `tone` | role=progressbar |
| `Field` | `label`, bind `value`, `type`, `hint`, `error`, `required`, `min/max/step` (ISO strings for `type="date"`), `hideLabel`, `width`; or a slot (let:id let:describedby let:invalid) | label/hint/error wired with aria |
| `Select` | `label`, bind `value`, `options` [{ value, label }], `hint`, `error`, `hideLabel`, `on:change` | native select (TV/keyboard) |
| `Toggle` | `label`, bind `checked`, `hint`, `pending`, `on:change` (detail = checked) | `role=switch` |
| `CopyField` | `label`, `value`, `qr`, `hint` | Copy → toast; optional QR (`lib/qr.ts`) |
| `fmtBytes` (`ui/format.ts`) | bytes | localised "1,2 GB" |

## Admin shell

`routes/admin/+layout.svelte` renders `AdminShell`: sidebar groups (People, Content, Operations; `lib/admin/nav.ts`)
with `aria-current` and badges from `/api/admin/summary` (`lib/admin/summary.ts`: `summary` store, `refreshSummary()`,
`bumpPending(key, ±1)` for optimistic badges). The shell owns the page `<h1>` and `<title>` (from the nav item) –
pages must not add their own. Phone: `/admin` shows the grouped list, sub-pages a back chevron.
Audit entries become sentences with `describeActivity(entry)` (`lib/admin/activity.ts`, keys `admin.activity.*`).
New admin page: add the route, a nav item in `nav.ts` and its label key; page texts go to `adminPeople` / `adminContent`.

Pages in the shell (`lib/admin/nav.ts`): **People** – users, roles, devices, invitations; **Content** – requests, polls, lists, hubs, leaving soon, previews; **Operations** – playback check, weekly recap, status, audit log, update. Badges: devices, requests and polls count what waits for a decision (amber), previews count failures (red).

The overview (`/admin`, `routes/admin/+page.svelte`) is built only from kit parts: a health strip of `StatusPill`s (media server, request service, version, previews, playback check), "Waiting for you" with inline approve / decline for requests (decline is delayed with Undo) and new devices, recent activity as sentences, `StatTile` counts and `Progress` bars for storage. One cheap call feeds the badges and the tiles – `GET /api/admin/summary` returns counts only (users, pending devices / polls / invites / failed previews, request counts, download and preview storage, last playback check, service reachability, running streams and party rooms); every source is optional, so a request service that is down shows "not reachable" instead of an error. Phone: the same area is a grouped list, each page opens with a back chevron.
