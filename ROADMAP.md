# Roadmap

What the maintainer plans for FriendFlix over roughly the next 12 months. This is a **plan, not a promise**: FriendFlix has a single maintainer, priorities shift with bug reports and free time, and items may move, shrink or be dropped. Day-to-day work is tracked in [GitHub issues](https://github.com/LetsManu/friendflix/issues); finished work is listed in the [CHANGELOG](CHANGELOG.md).

## Planned

1. **Block 22: admin care.** Make the admin area tell you when something needs attention:
   health status of the stack, disk usage, errors and transcodes, a warning banner for admins, library hygiene, and a per-user overview.
2. **Plex fork parity.** FriendFlix talks to its media server through one interface ([docs/architecture.md](docs/architecture.md), "Media server seam"); only Jellyfin is implemented in this repository. The goal is to keep that seam clean so that a fork can add another media server without touching shared code, and to bring features that exist only in such a fork back in a media-server-neutral way where it makes sense.
3. **AirPlay and cast receiver compatibility hardening.** More testing across Apple TV, AirPlay 2 TVs and Chromecast receivers, better diagnostics on the Diagnose page, and fewer surprises when a receiver cannot load its stream ([docs/cast.md](docs/cast.md)).
4. **Test coverage reporting, then higher coverage.** First make coverage visible in CI, then raise it, starting with security-relevant code (authentication, sessions, cast tokens, the gateway).
5. **Accessibility review.** A structured pass over the web app (keyboard, screen reader, contrast, reduced motion, TV mode) and fixes for what it finds.
6. **First tagged releases.** Cut real releases with the *Release* workflow: SemVer versions, a cinema-snack codename per major version, release notes from the changelog, signed images ([SECURITY.md](SECURITY.md), "Supported versions").
7. **Possibly: SPDX license headers** in source files (`SPDX-License-Identifier: AGPL-3.0-or-later`), if the maintenance cost stays low.

## Out of scope

- **Public multi-tenant hosting.** FriendFlix is for one household or friend group on a server you run yourself, not a service for strangers.
- **DRM.** There is no copy protection; downloads are for trusted people (see the README, "Privacy and safety").
- **A transcoding engine of its own.** Transcoding stays the job of the media server (Jellyfin); FriendFlix only chooses and caps what it asks for.

## Influence the plan

Open an issue with the feature request template, or comment on an existing one. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute.
