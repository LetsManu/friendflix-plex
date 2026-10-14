// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests for scripts/spdx.mjs (node:test, run by `npm test` at the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addHeader, hasHeader, styleFor } from './spdx.mjs';

test('comment style per file type', () => {
  assert.deepEqual(styleFor('backend/src/app.ts'), { pre: '// ', post: '' });
  assert.deepEqual(styleFor('web/src/lib/Player.svelte'), { pre: '<!-- ', post: ' -->' });
  assert.deepEqual(styleFor('web/src/app.css'), { pre: '/* ', post: ' */' });
  assert.deepEqual(styleFor('backend/Dockerfile'), { pre: '# ', post: '' });
  assert.deepEqual(styleFor('compose.yaml'), { pre: '# ', post: '' });
  assert.equal(styleFor('package.json'), null);
  assert.equal(styleFor('README.md'), null);
  assert.equal(styleFor('docs/images/logo.svg'), null);
});

test('header goes first, or right after a shebang / syntax directive / doctype', () => {
  const ts = addHeader('export const a = 1;\n', styleFor('a.ts'));
  assert.match(ts, /^\/\/ SPDX-FileCopyrightText: 2026 Manuel Weißböck\n\/\/ SPDX-License-Identifier: AGPL-3.0-or-later\nexport/);
  const sh = addHeader('#!/usr/bin/env bash\necho hi\n', styleFor('x.sh'));
  assert.match(sh, /^#!\/usr\/bin\/env bash\n# SPDX-FileCopyrightText: .*\n# SPDX-License-Identifier: AGPL-3.0-or-later\necho hi\n$/);
  const df = addHeader('# syntax=docker/dockerfile:1\nFROM x\n', styleFor('Dockerfile'));
  assert.match(df, /^# syntax=docker\/dockerfile:1\n# SPDX-FileCopyrightText/);
  const html = addHeader('<!doctype html>\n<html></html>\n', styleFor('app.html'));
  assert.match(html, /^<!doctype html>\n<!-- SPDX-FileCopyrightText: .* -->\n<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->\n<html>/);
});

test('idempotent: a file with a header is left alone', () => {
  const once = addHeader('const a = 1;\n', styleFor('a.ts'));
  assert.equal(addHeader(once, styleFor('a.ts')), once);
  assert.ok(hasHeader(once));
});
