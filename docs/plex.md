# FriendFlix for Plex – setup guide

> **Status: in development / preview.** The Plex support is being built and is **not released yet**. This guide describes the target setup of the first preview release; names such as `compose.plex.yaml` and the `friendflix-plex-*` images are planned. Facts about Plex's behaviour were verified against a real Plex Media Server 1.43; things marked *planned* are design decisions that are not implemented yet.
>
> Using Jellyfin? Use the upstream project, [LetsManu/friendflix](https://github.com/LetsManu/friendflix). Deutsch: [de/plex.md](de/plex.md).

Back to the [README](../README.md).

## How it works in one minute

- **One Plex server per FriendFlix instance.**
- FriendFlix manages its users itself with **one Plex admin token**. Your friends do not need a plex.tv account, and it works without Plex Pass.
- Profiles, kids profiles, age limits, watch progress and favourites are stored **in FriendFlix**, not in Plex. FriendFlix never writes watch state to Plex.
- The token is only used by the gateway and the backend on the server. It is never sent to a browser; clients only see FriendFlix URLs.
- `compose.plex.yaml` only **connects to your existing Plex server** (`PLEX_URL`, `PLEX_TOKEN` or `PLEX_TOKEN_FILE`). It does not start a Plex container.

## 1. Claim the server

FriendFlix needs a **claimed** server and a token. An unclaimed Plex server only answers token-less requests from the machine it runs on, so it cannot be used from a container or another host.

1. Open the Plex web app (`http://<server>:32400/web`) and sign in with a Plex account. This claims the server.
2. For Docker installs of Plex you can claim at first start with a claim token from <https://plex.tv/claim> (`PLEX_CLAIM`); the token is valid for a few minutes only.

## 2. Get the admin token

Follow Plex's own support article **"Finding an authentication token / X-Plex-Token"** (search for that title on support.plex.tv). The token is sent as `X-Plex-Token`.

Recommendations:

- Use a **dedicated Plex account** (or at least a dedicated token) for FriendFlix, not your daily account. Plex stores the selected audio track per Plex account, and FriendFlix has to change it when someone picks a language (see [Audio tracks](#audio-tracks)). If other Plex apps use the same account, they would see those changes.
- The token is a password: keep it in `PLEX_TOKEN_FILE` (Docker secret, see `compose.secrets.yaml`) rather than in `.env` where you can, and do not paste it into issues or chats. If it leaks, revoke it as described in Plex's documentation (for example by removing the device in your account's authorised devices) and create a new one.

Check it from the machine that runs FriendFlix:

```bash
curl -s -H "X-Plex-Token: $PLEX_TOKEN" -H "Accept: application/json" "$PLEX_URL/identity"
```

`"claimed": true` and a version number means the server is reachable; a `401` means the token is wrong or the server is not claimed.

## 3. Configure FriendFlix

```bash
# .env (planned variable names)
MEDIA_SERVER=plex
PLEX_URL=http://192.168.1.10:32400
PLEX_TOKEN=...            # or PLEX_TOKEN_FILE=/run/secrets/plex_token

docker compose -f compose.prod.yaml -f compose.plex.yaml up -d   # coming with the first preview release
```

Images (planned): `ghcr.io/letsmanu/friendflix-plex-backend`, `-web`, `-gateway`.

### Network

- The **gateway and backend must be able to reach `PLEX_URL`**. Use the **local address** of the Plex server (LAN IP or a host name that resolves on the Docker host, port 32400). Do not use the public `plex.direct` / remote-access address: it adds latency, may go through Plex's relay and is not needed.
- Plex does not have to be reachable by browsers. Only the FriendFlix portal is public.
- If Plex runs on the same host in Docker, put both on a shared Docker network or use the host's LAN IP.
- FriendFlix always sends the token, so it does not depend on Plex treating the connection as "local".

## 4. Library naming and role access

FriendFlix mirrors your Plex libraries (sections) and lets you decide **per role which libraries are visible** (for example: *Kids* role sees only `Kids Movies` and `Kids Shows`).

- Give libraries clear, stable names. The names are what you pick in the admin area.
- Prefer separate libraries for content that only some people should see (kids, adult, family videos) instead of relying on ratings alone.
- A library that is not allowed for a role is invisible to it, including search, recommendations and direct links.
- *Planned:* access is bound to the library, not its name; renaming a library in Plex should not drop access, but check the role settings afterwards.

## 5. Age ratings

Age limits and kids profiles rely on the Plex **content rating** (`contentRating`) of each title.

- FriendFlix maps common Plex ratings to a minimum age (for example `G`, `PG`, `PG-13`, `R`, `NC-17`, `TV-Y`, `TV-G`, `TV-PG`, `TV-14`, `TV-MA` and country-prefixed values such as `de/12`). The full table will be listed here and lives in `backend/src/plex/` once implemented.
- **Unknown or empty ratings are blocked for profiles with an age limit and for kids profiles** (fail closed). Profiles without a limit see everything allowed by their role.
- Episodes inherit the rating of their show unless they carry their own.

Fix a wrong or missing rating in Plex:

1. Open the title in Plex, **Edit** (pencil) → **Advanced** → **Content Rating**.
2. Enter a standard value and **lock** the field, so a metadata refresh does not overwrite it.
3. Plex does **not** update the item's modification date when metadata is edited, so FriendFlix cannot see it from timestamps alone. It re-checks all ratings in regular sweeps and listens to Plex's notifications (*planned*); a change can take a few minutes to appear.

Tip: in Plex, filter the library by *Content Rating* to spot titles without one. Matching a title to the correct entry ("Fix Match") often fills the rating in.

## 6. Preview thumbnails (scrubbing)

Hover and scrub previews need Plex's **video preview thumbnails** (BIF files). They work without Plex Pass but are off by default.

1. Plex → **Settings → Library → "Generate video preview thumbnails"**: set it to *as a scheduled task* or *as soon as possible*.
2. Per library: **Manage → Edit library → Advanced → Enable video preview thumbnails**.
3. Analyse existing titles (**…** → *Analyze*) or wait for the scheduled task.

Without them, FriendFlix shows no scrub thumbnails. With them it shows single frames (one every ~2 s), not a continuous sprite sheet.

## 7. Plex Pass (optional)

You do **not** need Plex Pass for FriendFlix. Plex Pass only adds things FriendFlix can then use:

- **Skip intro / skip credits**: need intro and credits markers, which Plex only detects with Plex Pass. Without markers the skip button never appears. Recap and preview skipping are never available.
- **Hardware transcoding** is a Plex feature (according to Plex it requires Plex Pass). It is configured in Plex, not in FriendFlix.

## 8. Plex settings to leave alone

- Do **not** create Plex users, Home users or shares for FriendFlix's members; FriendFlix does not use them.
- Leave **remote access / relay** as you like; FriendFlix does not use it.
- Keep **transcoder settings** (temporary directory, quality) as they are, or tune them for your hardware; FriendFlix just asks the Plex transcoder for HLS streams.
- Do not delete and re-create libraries without need: titles may get new internal IDs, so FriendFlix could treat them as new items (watch progress, lists and favourites would not follow).

## Feature parity

| Feature | Plex | Note |
|---|---|---|
| Profiles, kids profiles, PIN, age limits | Works | In FriendFlix; needs correct `contentRating` |
| Library, search, detail pages, cast, images | Works | Title logos only if Plex provides them, else title text |
| Continue watching, my list, favourites, ratings, history | Works | In FriendFlix |
| Direct play | Works | Streams the file via Plex |
| Adaptive streaming (HLS) | Works | MPEG-TS segments from the Plex universal transcoder, rewritten by the gateway |
| Subtitles | Works | Text subtitles extracted/converted to WebVTT by FriendFlix; no PGS |
| Audio track selection | Limited | Per Plex account; stream starts are serialized |
| Skip intro / credits | Limited | Plex Pass markers only; never recap/preview |
| Scrub preview thumbnails | Limited | Single frames; needs preview thumbnails enabled |
| "Upcoming episodes" | Not available | |
| Offline downloads | Works | Remuxed by FriendFlix |
| TV mode, Chromecast, watch parties, recommendations, notifications | Works | FriendFlix features |
| Wishes (request service) | Limited | Per-user mapping of requests degraded |
| nginx "Plan B" media path | Not available | Configuration is refused with Plex |

### Audio tracks

Plex's transcoder ignores an audio track chosen in the request; it uses the track **selected for the Plex account** that owns the token, taken when the stream starts. To give each viewer their own language, FriendFlix sets the selection for the token and starts the stream **one at a time**, so concurrent viewers still get their own track. Consequences:

- Starting several streams at the same instant is slightly slower (they queue for a moment).
- The selection of your FriendFlix token changes constantly. **Do not use the account you watch Plex on** for FriendFlix, or its audio track will flip around. Use a dedicated Plex account or token.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Health check or login fails, log shows `401` from Plex | Wrong or revoked `PLEX_TOKEN`, or server not claimed. Run the `curl` check from section 2. |
| `ECONNREFUSED` / timeouts to Plex | Gateway or backend cannot reach `PLEX_URL`. Test from the container; use the LAN address; check firewalls and Docker networks. |
| A library or title is missing | Role has no access to that library, or Plex has not finished scanning. Run a scan in Plex and wait for the next FriendFlix sync. |
| Kids/age-limited profiles see nothing | Titles have no or unknown `contentRating`. See [Age ratings](#5-age-ratings). |
| A rating change in Plex does not show up | Plex does not bump timestamps for metadata edits; wait for the next sweep (a few minutes). |
| No skip-intro button | No markers (needs Plex Pass) or none detected yet. |
| No scrub thumbnails | Preview thumbnails not enabled/generated in Plex, see section 6. |
| Wrong audio language or it changes while others watch | Another app uses the same Plex account. Use a dedicated token, see [Audio tracks](#audio-tracks). |
| Stream does not start / stalls at the start | The Plex transcoder needs a few seconds for the first segment; check Plex's transcoder temp space and CPU load, and Plex's logs. |
| Subtitles missing | Only text subtitles are offered; image subtitles (PGS) are not. |
| FriendFlix playback does not show in Plex "Now Playing" | Expected: FriendFlix does not report playback to Plex. |

## Keeping in sync with upstream (maintainers)

This repository is a fork of [LetsManu/friendflix](https://github.com/LetsManu/friendflix). To keep merges small:

```bash
git remote add upstream https://github.com/LetsManu/friendflix.git   # once
git fetch upstream
git switch main && git merge upstream/main          # regularly, e.g. weekly or per upstream release
```

- Plex code lives in `backend/src/plex/` and in the gateway's upstream adapter; shared code only gets the minimum changes needed (the media-server interface). Prefer adding files over editing upstream files.
- Jellyfin-specific docs (`docs/integrations.md`, `docs/operations.md`, `docs/monitoring.md`, `docs/downloads.md`, `docs/discovery.md`, `docs/setup.md`, `docs/authentik.md` and their `docs/de/` twins) only carry a short note at the top pointing here, so upstream edits merge cleanly. Do not rewrite them in this fork.
- README, `docs/plex.md`, `docs/de/plex.md` and branding are fork-only and will conflict only in the README: resolve by taking the fork text and re-applying upstream's factual changes (new env vars, features).
- After each merge run lint, typecheck and the test suites, including the Plex tests against the fake Plex server.
- Unrelated upstream features that depend on Jellyfin need a Plex equivalent or an entry in the parity table above.

## Trademark note

Plex is a trademark of Plex, Inc.; this project is not affiliated with or endorsed by Plex.
