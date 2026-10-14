// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { get } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Small app-level modules: SvelteKit hooks and route options, the manifest endpoint, and tiny UI helpers.
const nav = vi.hoisted(() => ({ pushState: vi.fn(), replaceState: vi.fn() }));
const tel = vi.hoisted(() => ({ installTelemetry: vi.fn(), reportError: vi.fn() }));
vi.mock('$app/navigation', () => nav);
vi.mock('$app/env', () => ({ version: 'v42' }));
vi.mock('#lib/telemetry', () => tel);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('server hook', () => {
  it('adds the security headers to every response', async () => {
    const { handle } = await import('./hooks.server');
    const res = await handle({ event: {} as never, resolve: async () => new Response('ok') });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
  });
});

describe('client hook', () => {
  it('installs telemetry with the build version and reports unexpected errors (still logged)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handleError } = await import('./hooks.client');
    expect(tel.installTelemetry).toHaveBeenCalledWith({ release: 'v42' });
    const e = new Error('boom');
    handleError({ kind: 'unknown', error: e, event: {} as never } as Parameters<typeof handleError>[0]);
    expect(err).toHaveBeenCalledWith(e);
    expect(tel.reportError).toHaveBeenCalledWith(e);
  });
});

describe('route options', () => {
  it('the app is a client-rendered SPA; only the offline hub is prerendered (the service worker caches it)', async () => {
    expect(await import('./routes/+layout')).toMatchObject({ ssr: false, prerender: false });
    expect(await import('./routes/offline/+page')).toMatchObject({ ssr: true, prerender: true });
  });
});

describe('web app manifest endpoint', () => {
  it('answers the manifest in the requested language, short-cached and varying by Accept-Language', async () => {
    const { GET, prerender } = await import('./routes/manifest.webmanifest/+server');
    expect(prerender).toBe(false);
    const call = (q: string, al: string) => GET({ url: new URL(`https://p.example/manifest.webmanifest${q}`), request: new Request('https://p.example/', { headers: { 'accept-language': al } }) } as never);
    const res = await call('?lang=en', 'de');
    expect(res.headers.get('content-type')).toBe('application/manifest+json');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('vary')).toBe('Accept-Language');
    const en = await res.json();
    const fr = await (await call('', 'fr-FR,fr;q=0.9')).json();
    expect(en.lang).toBe('en');
    expect(fr.lang).toBe('fr');
  });
});

describe('detail popup routing', () => {
  const click = (extra: Partial<MouseEvent> = {}) => ({ metaKey: false, ctrlKey: false, shiftKey: false, button: 0, preventDefault: vi.fn(), ...extra }) as unknown as MouseEvent & { preventDefault: ReturnType<typeof vi.fn> };

  it('a plain click opens the popup by shallow routing; modified or middle clicks open the page normally', async () => {
    const { openModal, swapModal } = await import('./lib/modal');
    const e = click();
    openModal(e, '/title/abc');
    expect(e.preventDefault).toHaveBeenCalled();
    expect(nav.pushState).toHaveBeenCalledWith('/title/abc', { modalId: 'abc' });
    for (const m of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
      const x = click(m);
      openModal(x, '/title/zzz');
      expect(x.preventDefault).not.toHaveBeenCalled();
    }
    expect(nav.pushState).toHaveBeenCalledTimes(1);
    swapModal('/title/def');
    expect(nav.replaceState).toHaveBeenCalledWith('/title/def', { modalId: 'def' });
  });
});

describe('UI helpers', () => {
  it('fmtBytes uses binary units in the UI language', async () => {
    const { fmtBytes } = await import('./lib/ui/format');
    const { setLocale } = await import('./lib/i18n');
    await setLocale('en');
    expect(fmtBytes(0)).toBe('0 byte');
    expect(fmtBytes(null)).toBe('0 byte');
    expect(fmtBytes(1536)).toBe('1.5 kB');
    expect(fmtBytes(340 * 1024 * 1024)).toBe('340 MB');
    expect(fmtBytes(5 * 1024 ** 5)).toBe('5,120 TB');
    await setLocale('de');
    expect(fmtBytes(1.25 * 1024 ** 3)).toMatch(/^1,3\sGB$/); // German: decimal comma (Intl may use a no-break space)
  });

  it('uid gives unique ids per prefix call', async () => {
    const { uid } = await import('./lib/ui/ids');
    const a = uid(), b = uid('field');
    expect(a).toMatch(/^ui-\d+$/);
    expect(b).toMatch(/^field-\d+$/);
    expect(a).not.toBe(uid());
  });

  it('dur drops transition durations for reduced motion', async () => {
    const { dur, reducedMotion } = await import('./lib/ui/motion');
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(dur(200)).toBe(200);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(reducedMotion()).toBe(true);
    expect(dur(200)).toBe(0);
  });

  it('avatars: known colour keys, red as fallback; initials', async () => {
    const { AVATARS, avatarBg, initial } = await import('./lib/avatars');
    expect(avatarBg('blue')).toBe(AVATARS[1]![2]);
    expect(avatarBg('nope')).toBe(AVATARS[0]![2]);
    expect(avatarBg(undefined)).toBe(AVATARS[0]![2]);
    expect(initial(' lea')).toBe('L');
    expect(initial('')).toBe('?');
    expect(initial(undefined)).toBe('?');
  });

  it('subtitle style classes and label keys', async () => {
    const { subClasses, SIZE_LABELS, FONT_LABELS } = await import('./lib/substyle');
    const { hasKey } = await import('./lib/i18n');
    expect(subClasses({ size: 'l', color: 'yellow', background: 'solid', font: 'mono' })).toBe('sub-size-l sub-color-yellow sub-bg-solid sub-font-mono');
    expect([...Object.values(SIZE_LABELS), ...Object.values(FONT_LABELS)].every((k) => hasKey(k))).toBe(true);
  });

  it('spoiler protection hides unwatched, unstarted episodes only', async () => {
    const { isSpoiler } = await import('./lib/spoiler');
    const on = { spoilerProtection: true };
    expect(isSpoiler({ type: 'Episode', played: false, positionTicks: 0 }, on)).toBe(true);
    expect(isSpoiler({ type: 'Episode', played: false, positionTicks: 5 }, on)).toBe(false);
    expect(isSpoiler({ type: 'Episode', played: true, positionTicks: 0 }, on)).toBe(false);
    expect(isSpoiler({ type: 'Movie', played: false, positionTicks: 0 }, on)).toBe(false);
    expect(isSpoiler({ type: 'Episode', played: false, positionTicks: 0 }, { spoilerProtection: false })).toBe(false);
  });

  it('the preview sheet store opens with the item and its opener, closes to null', async () => {
    const { previewSheet, openPreview, closePreview } = await import('./lib/previewSheet');
    const item = { id: 'x' } as never;
    openPreview(item, null);
    expect(get(previewSheet)).toEqual({ item, opener: null });
    closePreview();
    expect(get(previewSheet)).toBeNull();
  });
});

describe('OPFS probe worker', () => {
  it('reports whether sync access handles exist in a worker, then closes', async () => {
    for (const [proto, expected] of [[{ createSyncAccessHandle() {} }, true], [{}, false]] as const) {
      const posted: unknown[] = [];
      const close = vi.fn();
      vi.stubGlobal('self', { FileSystemFileHandle: { prototype: proto }, navigator: { storage: { getDirectory() {} } }, postMessage: (m: unknown) => posted.push(m), close });
      vi.resetModules();
      await import('./lib/offline/probe-worker');
      expect(posted).toEqual([{ type: 'opfs-probe', sync: expected }]);
      expect(close).toHaveBeenCalled();
    }
  });
});
