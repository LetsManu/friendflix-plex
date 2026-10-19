// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasKey, setLocale, tr } from '#lib/i18n';
import { HIDE_MS, MOVE_GUIDE_DE, MOVE_GUIDE_EN, hideMove, moveGuideUrl, moveHidden, moveNoticeAudience } from './moveNotice';

afterEach(async () => { vi.unstubAllGlobals(); await setLocale('de'); });

const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('moveNoticeAudience', () => {
  it('shows for an admin on the owner profile only', () => {
    expect(moveNoticeAudience({ isAdmin: true, profile: { isOwner: true } })).toBe(true);
    expect(moveNoticeAudience({ isAdmin: false, profile: { isOwner: true } })).toBe(false);
    expect(moveNoticeAudience({ isAdmin: true, profile: { isOwner: false } })).toBe(false);
    expect(moveNoticeAudience({ isAdmin: true, kids: true, profile: { isOwner: true } })).toBe(false);
    expect(moveNoticeAudience(null)).toBe(false);
  });
});

describe('guide link', () => {
  it('German locale links the German guide, everything else the English one', () => {
    expect(moveGuideUrl('de')).toBe(MOVE_GUIDE_DE);
    for (const l of ['en', 'es', 'fr', 'it', 'pl', 'tr']) expect(moveGuideUrl(l)).toBe(MOVE_GUIDE_EN);
    expect(MOVE_GUIDE_DE).toMatch(/^https:\/\/github\.com\/LetsManu\/friendflix\/blob\/main\/docs\/de\/plex\.md#umstieg/);
  });
});

describe('hiding for 7 days', () => {
  it('hidden per admin until the time is up, then back', () => {
    vi.stubGlobal('localStorage', store());
    expect(moveHidden('a', 1000)).toBe(false);
    hideMove('a', 1000);
    expect(moveHidden('a', 2000)).toBe(true);
    expect(moveHidden('b', 2000)).toBe(false);
    expect(moveHidden('a', 1000 + HIDE_MS)).toBe(false);
  });
  it('blocked storage never throws; the notice stays visible', () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } });
    expect(() => hideMove('a')).not.toThrow();
    expect(moveHidden('a')).toBe(false);
  });
});

describe('strings', () => {
  it('exist in all 7 locales', async () => {
    for (const l of ['de', 'en', 'es', 'fr', 'it', 'pl', 'tr'] as const) {
      await setLocale(l);
      for (const k of ['admin.move.text', 'admin.move.link', 'admin.move.label', 'admin.move.hide'] as const) { expect(hasKey(k)).toBe(true); expect(tr(k).length).toBeGreaterThan(3); }
    }
    await setLocale('en');
    expect(tr('admin.move.text')).toBe('FriendFlix for Plex has moved: FriendFlix 2.0 supports Plex directly. Switch to keep getting updates.');
  });
});
