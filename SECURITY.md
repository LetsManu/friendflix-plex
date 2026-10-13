# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report them privately through GitHub: **Security → Report a vulnerability** on this repository
(GitHub private vulnerability reporting). Include what you found, how to reproduce it and which version
(`version.json` / the version shown in the admin area) is affected.

You can expect a first answer within a week. Fixes are released as a patch version; the release notes name
the issue once a fix is available.

## Supported versions

Only the latest release (and `main`) receives security fixes. FriendFlix is self-hosted: please keep your
installation up to date (Admin → Version shows when a newer release exists).

## Scope

In scope: the backend, the media gateway, the web app and the deployment files in this repository.
Out of scope: Jellyfin / Plex themselves, your reverse proxy, and third-party services (TMDB, OMDb, ntfy, Discord) —
please report those to their maintainers.
