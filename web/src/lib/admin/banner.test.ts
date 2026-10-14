// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { banner, bannerView, dismiss, issueText, refreshBanner, setBannerForTests } from './banner';
import type { HealthIssue } from './health';

const issue = (id: string, level: 'warn' | 'err', reason: HealthIssue['reason'], detail?: HealthIssue['detail']): HealthIssue => ({ id, level, reason, fp: 'a'.repeat(12), ...(detail ? { detail } : {}) });

describe('bannerView', () => {
  it('err before warn; more = rest count; empty → level null', () => {
    const v = bannerView([issue('disk:downloads', 'warn', 'full', { pct: 93 }), issue('svc:media', 'err', 'down'), issue('svc:tmdb', 'warn', 'invalid_key')]);
    expect(v.first?.id).toBe('svc:media');
    expect(v.more).toBe(2);
    expect(v.level).toBe('err');
    expect(v.rest.map((i) => i.id)).toEqual(['disk:downloads', 'svc:tmdb']);
    expect(bannerView([issue('svc:tmdb', 'warn', 'invalid_key')]).level).toBe('warn');
    expect(bannerView([])).toEqual({ first: null, rest: [], more: 0, level: null });
  });
});

describe('issueText', () => {
  it('one sentence per id × reason family, with pct / n', () => {
    expect(issueText(issue('disk:downloads', 'warn', 'full', { pct: 93 }))).toBe('Download-Speicher fast voll (93 %)');
    expect(issueText(issue('svc:media', 'err', 'down'))).toBe('Medienserver nicht erreichbar');
    expect(issueText(issue('svc:tmdb', 'warn', 'invalid_key'))).toBe('TMDB-Schlüssel ungültig');
    expect(issueText(issue('errors:playback', 'warn', 'failed_playbacks', { n: 4 }))).toBe('4 Wiedergaben fehlgeschlagen');
    expect(issueText(issue('svc:playbackCheck', 'warn', 'failed_titles', { n: 2 }))).toBe('2 Titel im Wiedergabe-Check fehlgeschlagen');
    expect(issueText(issue('svc:playbackCheck', 'err', 'empty_media', { n: 86 }))).toBe('Medienserver liefert leere Videostücke – Jellyfin neu starten; hilft das nicht, Hardware-Beschleunigung prüfen');
    expect(issueText(issue('weird:thing', 'warn', 'slow'))).toBe('Etwas braucht deine Aufmerksamkeit');
  });
});

describe('dismiss', () => {
  afterEach(() => { vi.unstubAllGlobals(); setBannerForTests(null); });
  const res = (status: number, body: unknown) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) });

  it('removes the issue at once and posts {id, fp}; rolls back when the call fails', async () => {
    const a = issue('svc:media', 'err', 'down'), b = issue('disk:downloads', 'warn', 'full', { pct: 90 });
    setBannerForTests({ issues: [a, b], worst: 'err' });
    const fetch = vi.fn(async () => res(200, { ok: true }));
    vi.stubGlobal('fetch', fetch);
    const p = dismiss(a);
    expect(get(banner)?.issues.map((i) => i.id)).toEqual(['disk:downloads']);
    expect(await p).toBe(true);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toBe('/api/admin/health/dismiss');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ id: 'svc:media', fp: a.fp });

    vi.stubGlobal('fetch', vi.fn(async () => res(500, { error: 'x' })));
    expect(await dismiss(b)).toBe(false);
    expect(get(banner)?.issues.map((i) => i.id)).toEqual(['disk:downloads']);
  });

  it('a failing refresh keeps the last state', async () => {
    setBannerForTests({ issues: [issue('svc:media', 'err', 'down')], worst: 'err' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await refreshBanner();
    expect(get(banner)?.issues).toHaveLength(1);
  });
});
