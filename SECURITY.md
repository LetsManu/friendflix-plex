# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report them privately through GitHub: **Security → Report a vulnerability** on this repository
(GitHub private vulnerability reporting). Include what you found, how to reproduce it and which version
(`version.json` / the version shown in the admin area) is affected.

You can expect a first answer within a week. Fixes are released as a patch version; the release notes name
the issue once a fix is available.

## Supported versions

Only the **latest release line** (and `main`) receives security fixes. FriendFlix is self-hosted, so please keep your installation up to date:

- Update with `docker compose pull && docker compose up -d`. Database migrations run automatically.
- Breaking changes only happen in major versions and are documented in the [CHANGELOG](CHANGELOG.md).
- Admin → Version shows when a newer release exists.

## How we handle reports

1. You report privately (see above).
2. We acknowledge the report within 7 days.
3. We assess it: reproduce, rate the severity, find the affected versions. We may ask you questions.
4. We prepare the fix privately (in the private advisory, not in public commits or issues).
5. We publish a patch release with the fix.
6. We then publish a GitHub Security Advisory and request a CVE through GitHub where it applies, so the issue becomes visible to scanners.

## Credit

Reporters are credited in the advisory and in the release notes, unless they prefer to stay anonymous. Tell us how you want to be named.

## Scope

In scope: the backend, the media gateway, the web app and the deployment files in this repository.
Out of scope: Jellyfin / Plex themselves, your reverse proxy, and third-party services (TMDB, OMDb, ntfy, Discord) —
please report those to their maintainers.

For the design, trust boundaries and threat model behind this policy see [docs/security.md](docs/security.md).
