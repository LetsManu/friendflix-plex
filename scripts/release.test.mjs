// Unit tests for scripts/release.mjs (node:test, run by `npm test` at the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODENAMES, bump, bumpVersionInfo, changelogSection, cutChangelog, nextCodename, parseVersion, plan, release, setLockVersions, setPackageVersion } from './release.mjs';

const LOG = `# Changelog

Intro text.

## [Unreleased]

### Streaming
- New thing.

## [1.0.0] – Arancini – 2026-10-01

### Watching
- Old thing.
`;

test('bump: patch, minor, major', () => {
  assert.equal(bump('1.0.0', 'patch'), '1.0.1');
  assert.equal(bump('1.2.3', 'minor'), '1.3.0');
  assert.equal(bump('1.2.3', 'major'), '2.0.0');
  assert.equal(bump('0.9.9', 'patch'), '0.9.10');
  assert.throws(() => bump('1.0.0', 'huge'), /unknown bump/);
  assert.throws(() => bump('v1.0.0', 'patch'), /SemVer/);
  assert.throws(() => bump('1.0.0-rc.1', 'patch'), /SemVer/);
  assert.deepEqual(parseVersion('10.20.30'), [10, 20, 30]);
});

test('codenames: 26 generic snacks, A–Z in order', () => {
  assert.equal(CODENAMES.length, 26);
  const letters = CODENAMES.map((n) => n.normalize('NFD')[0].toUpperCase());
  assert.deepEqual(letters, [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']);
  assert.equal(CODENAMES[0], 'Arancini');
});

test('nextCodename: rolls over A → B on major, stops at Z', () => {
  assert.equal(nextCodename('Arancini'), 'Brezel');
  assert.equal(nextCodename('Donut'), 'Éclair');
  assert.throws(() => nextCodename('Zimtschnecke'), /exhausted/);
  assert.throws(() => nextCodename('Nope'), /unknown codename/);
  assert.deepEqual(bumpVersionInfo({ version: '1.4.2', codename: 'Arancini' }, 'major'), { version: '2.0.0', codename: 'Brezel' });
  assert.deepEqual(bumpVersionInfo({ version: '1.4.2', codename: 'Arancini' }, 'minor'), { version: '1.5.0', codename: 'Arancini' });
  assert.deepEqual(bumpVersionInfo({ version: '1.4.2', codename: 'Arancini' }, 'patch'), { version: '1.4.3', codename: 'Arancini' });
});

test('cutChangelog: new heading, fresh Unreleased, older sections kept', () => {
  const { text, notes } = cutChangelog(LOG, '1.1.0', 'Arancini', '2026-10-13');
  assert.equal(notes, '### Streaming\n- New thing.');
  assert.ok(text.startsWith('# Changelog\n\nIntro text.\n\n## [Unreleased]\n\n## [1.1.0] – Arancini – 2026-10-13\n\n### Streaming\n- New thing.\n\n## [1.0.0] – Arancini – 2026-10-01\n'));
  assert.ok(text.endsWith('### Watching\n- Old thing.\n'));
  assert.equal(text.match(/## \[Unreleased\]/g).length, 1);
});

test('cutChangelog: works when Unreleased is the last section', () => {
  const { text } = cutChangelog('# Changelog\n\n## [Unreleased]\n- Only.\n', '1.0.1', 'Arancini', '2026-10-13');
  assert.equal(text, '# Changelog\n\n## [Unreleased]\n\n## [1.0.1] – Arancini – 2026-10-13\n\n- Only.\n');
});

test('cutChangelog: refuses an empty Unreleased section (also headings only) and a missing one', () => {
  assert.throws(() => cutChangelog('# C\n\n## [Unreleased]\n\n## [1.0.0] – Arancini – 2026-10-01\n- x\n', '1.0.1', 'Arancini', '2026-10-13'), /empty/);
  assert.throws(() => cutChangelog('# C\n\n## [Unreleased]\n\n### Streaming\n\n', '1.0.1', 'Arancini', '2026-10-13'), /empty/);
  assert.throws(() => cutChangelog('# C\n', '1.0.1', 'Arancini', '2026-10-13'), /no "## \[Unreleased\]"/);
});

test('setPackageVersion / setLockVersions keep everything else', () => {
  const pkg = '{\n  "name": "x",\n  "version": "0.1.0",\n  "dependencies": { "a": "^1.0.0" }\n}\n';
  assert.equal(setPackageVersion(pkg, '1.2.0'), pkg.replace('0.1.0', '1.2.0'));
  assert.throws(() => setPackageVersion('{ "name": "x" }', '1.0.0'), /no "version"/);
  const lock = JSON.stringify({ name: 'x', version: '0.1.0', packages: { '': { version: '0.1.0' }, backend: { version: '0.1.0' }, web: { version: '0.2.0' }, 'node_modules/a': { version: '1.0.0' } } }, null, 2);
  const out = JSON.parse(setLockVersions(lock, '1.2.0', ['backend', 'web', 'gateway']));
  assert.equal(out.version, '1.2.0');
  assert.equal(out.packages[''].version, '1.2.0');
  assert.equal(out.packages.backend.version, '1.2.0');
  assert.equal(out.packages.web.version, '1.2.0');
  assert.equal(out.packages['node_modules/a'].version, '1.0.0');
  assert.equal(out.packages.gateway, undefined);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ff-release-'));
  writeFileSync(join(dir, 'version.json'), '{ "version": "1.3.2", "codename": "Arancini" }\n');
  writeFileSync(join(dir, 'CHANGELOG.md'), LOG);
  writeFileSync(join(dir, 'package.json'), '{\n  "name": "root",\n  "version": "1.3.2"\n}\n');
  for (const w of ['backend', 'web', 'gateway']) { mkdirSync(join(dir, w)); writeFileSync(join(dir, w, 'package.json'), `{\n  "name": "${w}",\n  "version": "1.3.2"\n}\n`); }
  writeFileSync(join(dir, 'package-lock.json'), `${JSON.stringify({ name: 'root', version: '1.3.2', packages: { '': { version: '1.3.2' }, backend: { version: '1.3.2' } } }, null, 2)}\n`);
  return dir;
}

test('release: major bump writes every file; dry run writes nothing', () => {
  const dir = fixture();
  const dry = release({ root: dir, kind: 'major', date: '2026-10-13', dryRun: true });
  assert.equal(dry.summary.version, '2.0.0');
  assert.equal(dry.summary.codename, 'Brezel');
  assert.equal(dry.summary.tag, 'v2.0.0');
  assert.equal(readFileSync(join(dir, 'version.json'), 'utf8'), '{ "version": "1.3.2", "codename": "Arancini" }\n');

  const r = release({ root: dir, kind: 'major', date: '2026-10-13' });
  assert.deepEqual(r.summary.files.sort(), ['CHANGELOG.md', 'backend/package.json', 'gateway/package.json', 'package-lock.json', 'package.json', 'version.json', 'web/package.json']);
  assert.equal(readFileSync(join(dir, 'version.json'), 'utf8'), '{ "version": "2.0.0", "codename": "Brezel" }\n');
  for (const f of ['package.json', 'backend/package.json', 'web/package.json', 'gateway/package.json']) assert.equal(JSON.parse(readFileSync(join(dir, f), 'utf8')).version, '2.0.0', f);
  assert.equal(JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')).packages.backend.version, '2.0.0');
  assert.match(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), /## \[Unreleased\]\n\n## \[2\.0\.0\] – Brezel – 2026-10-13\n\n### Streaming/);
  assert.equal(r.notes, '### Streaming\n- New thing.');
  // the Unreleased section is now empty: a second release is refused
  assert.throws(() => release({ root: dir, kind: 'patch', date: '2026-10-14' }), /empty/);
});

test('none: first release of the version already in version.json; refused once its tag exists', () => {
  assert.equal(bump('1.0.0', 'none'), '1.0.0');
  assert.deepEqual(bumpVersionInfo({ version: '1.0.0', codename: 'Arancini' }, 'none'), { version: '1.0.0', codename: 'Arancini' });
  const dir = fixture();
  assert.throws(() => release({ root: dir, kind: 'none', date: '2026-10-13', tags: ['v1.3.2'] }), /tag v1\.3\.2 already exists.*none/);
  const r = release({ root: dir, kind: 'none', date: '2026-10-13', tags: ['v1.3.1'] });
  assert.equal(r.summary.tag, 'v1.3.2');
  assert.equal(readFileSync(join(dir, 'version.json'), 'utf8'), '{ "version": "1.3.2", "codename": "Arancini" }\n');
  assert.match(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), /## \[Unreleased\]\n\n## \[1\.3\.2\] – Arancini – 2026-10-13\n\n### Streaming/);
});

test('every bump refuses an existing tag', () => {
  assert.throws(() => release({ root: fixture(), kind: 'patch', date: '2026-10-13', tags: ['v1.3.3'] }), /tag v1\.3\.3 already exists/);
});

test('setPackageVersion: only the top-level key, nested "version" keys and strings stay', () => {
  const pkg = '{\n  "name": "x",\n  "description": "has \\"version\\": \\"0.0.1\\" in text",\n  "config": { "version": "9.9.9", "deep": [{ "version": "8" }] },\n  "version": "0.1.0",\n  "workspaces": ["a"]\n}\n';
  const out = setPackageVersion(pkg, '1.2.0');
  assert.equal(JSON.parse(out).version, '1.2.0');
  assert.equal(JSON.parse(out).config.version, '9.9.9');
  assert.equal(JSON.parse(out).config.deep[0].version, '8');
  assert.equal(out, pkg.replace('"version": "0.1.0"', '"version": "1.2.0"'));
  // nested key BEFORE the top-level one is the trap of a plain regex
  assert.throws(() => setPackageVersion('{ "config": { "version": "1" } }', '2.0.0'), /no "version"/);
  assert.throws(() => setPackageVersion('{ broken', '2.0.0'));
});

test('plan and changelogSection (used by release.yml to resume a half-finished release)', () => {
  const dir = fixture();
  assert.deepEqual(plan({ root: dir, kind: 'minor' }), { version: '1.4.0', codename: 'Arancini', tag: 'v1.4.0', previous: '1.3.2' });
  assert.deepEqual(plan({ root: dir, kind: 'none' }), { version: '1.3.2', codename: 'Arancini', tag: 'v1.3.2', previous: '1.3.2' });
  assert.equal(changelogSection(LOG, '1.0.0'), '### Watching\n- Old thing.');
  const cut = cutChangelog(LOG, '1.1.0', 'Arancini', '2026-10-13').text;
  assert.equal(changelogSection(cut, '1.1.0'), '### Streaming\n- New thing.');
  assert.throws(() => changelogSection(LOG, '1.0.1'), /no section for 1\.0\.1/);
  assert.throws(() => changelogSection(LOG, '1x0x0'), /not a release version/); // only plain X.Y.Z is accepted
  assert.throws(() => changelogSection(LOG, '9.9.9'), /no section/);
});
