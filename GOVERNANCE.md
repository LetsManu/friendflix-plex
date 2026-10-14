# Governance

FriendFlix is a small, single-maintainer open-source project. This document describes how decisions are made and who
holds which role.

## Roles

| Role | Who | Responsibilities |
|---|---|---|
| **Maintainer** (project lead) | Manuel Weißböck ([@LetsManu](https://github.com/LetsManu)) | Sets the direction and roadmap, reviews and merges pull requests, cuts releases, handles security reports ([SECURITY.md](SECURITY.md)), manages the repository settings and the Plex fork ([LetsManu/friendflix-plex](https://github.com/LetsManu/friendflix-plex)). |
| **Contributors** | Anyone who opens an issue or a pull request | Report bugs, suggest features, submit changes following [CONTRIBUTING.md](CONTRIBUTING.md). |

There are currently no other maintainers or committers. If the project grows, trusted long-term contributors can be
invited as additional maintainers; this document will then be updated to list them and how decisions are shared.

## How decisions are made

- **Day-to-day changes** (bug fixes, small features, docs) are proposed as pull requests. A change is merged by the
  maintainer once CI is green and it meets the requirements in CONTRIBUTING.md.
- **Larger features or design changes** start as a GitHub issue (or a design document under `docs/superpowers/specs/`)
  so the approach can be discussed before code is written. The maintainer makes the final decision and records the
  reasoning in the issue or the spec.
- **Releases** follow Semantic Versioning (`version.json`, tags `vX.Y.Z`) and are cut by the maintainer with the
  *Release* workflow; notable changes are listed in [CHANGELOG.md](CHANGELOG.md).
- **Security issues** are handled privately as described in [SECURITY.md](SECURITY.md) and take priority over other work.
- **Disagreements** are discussed openly in the relevant issue or pull request. If no consensus is reached, the
  maintainer decides.

## Bus factor and succession

The project currently has **one active maintainer** (bus factor 1). This is known and is being addressed:

- **A second maintainer is planned.** A trusted friend of the maintainer has agreed to join as co-maintainer once they
  have time. Until then they have no write access; when they join, they will be added to the roles table above with
  write access to the repository and GHCR, and this section will be updated.
- **Knowledge is written down, not in one head.** Architecture (docs/architecture.md), setup and operations
  (docs/setup.md, docs/operations.md), the security model (docs/security.md), design specs and implementation plans
  (docs/superpowers/) and the release process (`.github/workflows/release.yml`) are all in the repository, so another
  developer can take over without the current maintainer.
- **Everything is reproducible from the public repository:** CI builds, tests and publishes the images; no step depends
  on the maintainer's machine.
- **Handover:** if the maintainer becomes unavailable, repository and package ownership is to be transferred to the
  co-maintainer (or, before one exists, the project is marked as archived so users can fork it).

## Continuity

The repository, issues, releases and documentation are public, and the project is licensed under the
[GNU AGPL v3.0 or later](LICENSE), so anyone can fork and continue the project. Should the maintainer become unable to
continue, they will try to hand over the repository to a trusted contributor or mark it as archived.
