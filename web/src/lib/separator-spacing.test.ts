import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** all .svelte files below src/ */
function svelteFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) svelteFiles(p, out);
    else if (name.endsWith('.svelte')) out.push(p);
  }
  return out;
}

describe('separators in templates', () => {
  // Svelte drops whitespace at the start of a block: `{#if x} · {y}` renders "Downloaded· 650 MB". Use `{' · '}`.
  it('no " · " right after an {#if}/{:else} opening', () => {
    const src = fileURLToPath(new URL('..', import.meta.url));
    const bad: string[] = [];
    for (const f of svelteFiles(src)) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/\{(#if|:else)[^}]*\}\s+·/.test(line)) bad.push(`${f.slice(src.length)}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
