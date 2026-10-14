// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { basePrecache, isShellFont, localeManifest, localeUrls, shellUrls } from './precache';

const HTML = `<link href="./_app/immutable/entry/start.BPnn_j0w.js" rel="modulepreload">
<link href="./_app/immutable/chunks/CRzLMJPS.js" rel="modulepreload">
<link href="./_app/immutable/assets/0.DdEFIxH_.css" rel="stylesheet">
<link href="/favicon.svg" rel="icon">
<script>Promise.all([import("./_app/immutable/entry/start.BPnn_j0w.js"), import("./_app/immutable/entry/app.DGxLNkhK.js")])</script>`;

describe('service worker precache', () => {
  it('collects the shell modules and styles of the offline page', () => {
    expect(shellUrls(HTML).sort()).toEqual([
      '/_app/immutable/assets/0.DdEFIxH_.css',
      '/_app/immutable/chunks/CRzLMJPS.js',
      '/_app/immutable/entry/app.DGxLNkhK.js',
      '/_app/immutable/entry/start.BPnn_j0w.js',
    ]);
  });
  it('keeps only the latin Inter subset', () => {
    expect(isShellFont('/_app/immutable/assets/inter-latin-wght-normal.Dx4kXJAl.woff2')).toBe(true);
    expect(isShellFont('/_app/immutable/assets/inter-latin-ext-wght-normal.DO1Apj_S.woff2')).toBe(false);
    expect(isShellFont('/_app/immutable/assets/inter-cyrillic-wght-normal.DqGufNeO.woff2')).toBe(false);
  });
  it('base list: prerendered pages, icons, shell font; no route chunks', () => {
    const l = basePrecache({ immutable: ['/_app/immutable/nodes/5.x.js', '/_app/immutable/assets/inter-latin-wght-normal.a.woff2', '/_app/immutable/assets/inter-greek-wght-normal.b.woff2'], prerendered: ['/offline'], statics: ['/favicon.svg', '/offline'] });
    expect(l).toEqual(['/offline', '/favicon.svg', '/_app/immutable/assets/inter-latin-wght-normal.a.woff2']);
  });
});

describe('offline language chunks', () => {
  const bundle = {
    'a': { type: 'chunk', fileName: '_app/immutable/chunks/AbC.js', facadeModuleId: '/r/web/src/lib/i18n/locales/en/index.ts', imports: ['_app/immutable/chunks/Shared.js'] },
    'b': { type: 'chunk', fileName: '_app/immutable/chunks/PlX.js', facadeModuleId: '/r/web/src/lib/i18n/locales/pl/index.ts', imports: [] },
    'c': { type: 'chunk', fileName: '_app/immutable/chunks/De.js', facadeModuleId: '/r/web/src/lib/i18n/locales/de/index.ts' },
    'd': { type: 'chunk', fileName: '_app/immutable/nodes/1.js', facadeModuleId: '/r/web/src/routes/+page.svelte' },
    'e': { type: 'chunk', fileName: 'chunks/ssr.js', facadeModuleId: '/r/web/src/lib/i18n/locales/fr/index.ts' },
    'f': { type: 'asset', fileName: '_app/immutable/assets/x.css' },
  };
  it('maps each non-German language of the client build to its chunk + imports', () => {
    expect(localeManifest(bundle)).toEqual({
      en: ['/_app/immutable/chunks/AbC.js', '/_app/immutable/chunks/Shared.js'],
      pl: ['/_app/immutable/chunks/PlX.js'],
    });
  });
  it('is null for builds without locale chunks (SSR / service worker)', () => {
    expect(localeManifest({ e: bundle.e })).toBeNull();
  });
  it('picks only files of this build for the stored language', () => {
    const man = localeManifest(bundle);
    const known = new Set(['/_app/immutable/chunks/AbC.js']);
    expect(localeUrls(man, 'en', known)).toEqual(['/_app/immutable/chunks/AbC.js']);
    expect(localeUrls(man, 'de', known)).toEqual([]);
    expect(localeUrls(man, null, known)).toEqual([]);
    expect(localeUrls(man, 'it', known)).toEqual([]);
    expect(localeUrls('garbage', 'en', known)).toEqual([]);
  });
});
