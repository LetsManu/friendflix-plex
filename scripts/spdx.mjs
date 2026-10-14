#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-file copyright and license headers (SPDX). `node scripts/spdx.mjs --check` lists tracked source files without a
// header (exit 1, used in CI); `--fix` adds the header. Comment style follows the file type; a shebang, a Dockerfile
// `# syntax=` directive or an HTML doctype stays on the first line.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import console from 'node:console';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const COPYRIGHT = 'SPDX-FileCopyrightText: 2026 Manuel Weißböck';
export const LICENSE = 'SPDX-License-Identifier: AGPL-3.0-or-later';

/** comment style per file, or null when the file gets no header (data, images, docs) */
export function styleFor(path) {
  const base = path.split('/').pop() ?? '';
  if (/\.(ts|js|mjs|cjs)$/.test(base)) return { pre: '// ', post: '' };
  if (/\.css$/.test(base)) return { pre: '/* ', post: ' */' };
  if (/\.(svelte|html)$/.test(base)) return { pre: '<!-- ', post: ' -->' };
  if (/\.(sh|ya?ml|conf)$/.test(base) || base === 'Dockerfile' || path.startsWith('githooks/')) return { pre: '# ', post: '' };
  return null;
}

/** lines that must stay first: shebang, Dockerfile parser directive, HTML doctype */
const KEEP_FIRST = /^(#!|# ?syntax=|<!doctype)/i;

export const hasHeader = (text) => text.slice(0, 600).includes('SPDX-License-Identifier:');

/** text with the header added (unchanged if it already has one) */
export function addHeader(text, style) {
  if (hasHeader(text)) return text;
  const header = `${style.pre}${COPYRIGHT}${style.post}\n${style.pre}${LICENSE}${style.post}\n`;
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (KEEP_FIRST.test(first)) return nl === -1 ? `${first}\n${header}` : `${first}\n${header}${text.slice(nl + 1)}`;
  return header + text;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fix = process.argv.includes('--fix');
  const missing = [];
  for (const path of trackedFiles()) {
    const style = styleFor(path);
    if (!style) continue;
    const text = readFileSync(path, 'utf8');
    if (hasHeader(text)) continue;
    if (fix) writeFileSync(path, addHeader(text, style));
    else missing.push(path);
  }
  if (missing.length) {
    console.error(`SPDX header missing in ${missing.length} file(s) – run: node scripts/spdx.mjs --fix\n${missing.join('\n')}`);
    process.exit(1);
  }
}
