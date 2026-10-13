# Contributing to FriendFlix

Thanks for helping! Bug reports, ideas and pull requests are welcome.

## Reporting bugs and asking for features

- **Bugs and ideas:** open a [GitHub issue](https://github.com/LetsManu/friendflix/issues/new/choose) (bug report or feature request template). For bugs, say what you did, what you expected and what happened, plus the
  version (Admin → Version, or `version.json`) and browser/device. For player or casting problems, attach the log from
  the **Diagnose** page (it never contains addresses or tokens).
- **Security problems:** never in a public issue – see [SECURITY.md](SECURITY.md).

## Pull requests

1. Fork the repo and branch from `main`.
2. Keep a pull request to one topic. Larger features: open an issue first so we can agree on the design.
3. Make sure all checks below pass locally, then open the PR. CI must be green before it is merged (merge commit).

## Requirements for acceptable contributions

**Code standard**
- TypeScript in strict mode (`tsconfig.base.json`) for backend, gateway and web; Svelte components in `web/`.
- Lint rules: [`eslint.config.js`](eslint.config.js). `npm run lint` and `npm run typecheck` must pass with no errors.
- Follow the patterns of the surrounding code (naming, comment density, file layout). Prefer small, focused files.
- UI: use the shared kit components and design tokens ([docs/ui-kit.md](docs/ui-kit.md)); work on phone, desktop and TV
  mode ([docs/tv-mode.md](docs/tv-mode.md)); keyboard and screen-reader friendly.

**Tests**
- New behaviour comes with tests; bug fixes come with a test that fails without the fix.
- Unit tests: Vitest (`npm test`). End-to-end: Playwright (`npm run e2e`) for user-visible flows.

**Texts and languages**
- Every user-facing string goes through i18n and is added in **all 7 languages** ([docs/i18n.md](docs/i18n.md)).
- Neutral wording and visuals: no logos, fonts, colours or names that imitate other streaming services; screenshots use
  fictional titles and generated art only.

**Security**
- Never commit secrets, tokens or real passwords (CI runs gitleaks). Test fixtures use obviously fake values.
- Media server credentials must never reach the browser; new media paths go through the gateway's authorization.
- New dependencies need a reason in the PR; prefer none. They must be under a license compatible with AGPL-3.0.

**Commits and docs**
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:` …).
- Update the docs (`README.md` / `README.de.md`, `docs/`) and add a line to `CHANGELOG.md` under *Unreleased* for
  anything a user or admin notices.

## Checks to run before opening a PR

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run e2e        # needs the Playwright browsers; see e2e/
```

## License of contributions

FriendFlix is licensed under the [GNU AGPL v3.0 or later](LICENSE). By submitting a contribution you agree that it is
licensed under the same terms (inbound = outbound) and that you have the right to submit it. Please add a
`Signed-off-by:` line to your commits (`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/).
