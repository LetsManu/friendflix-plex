// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DEFAULT_INTRO, introKey, isIntroFreeRoute, parseIntroSettings, shouldPlayIntro, shouldPlayIntroSound } from './intro';

const base = { setting: true, reducedMotion: false, route: '/', sessionSeen: false, tv: false };

describe('shouldPlayIntro', () => {
  it('plays by default', () => expect(shouldPlayIntro(base)).toBe(true));
  it('respects the setting', () => expect(shouldPlayIntro({ ...base, setting: false })).toBe(false));
  it('never plays on TV', () => expect(shouldPlayIntro({ ...base, tv: true })).toBe(false));
  it('plays at most once per session', () => expect(shouldPlayIntro({ ...base, sessionSeen: true })).toBe(false));
  it('never plays during watch / party / public routes', () => {
    for (const route of ['/watch/abc', '/party/xyz', '/tv', '/invite/code', '/offline']) expect(shouldPlayIntro({ ...base, route })).toBe(false);
    expect(shouldPlayIntro({ ...base, route: '/watchlist' })).toBe(true);
  });
  it('reduced motion: user-triggered shows the calm fade, cold start is skipped', () => {
    expect(shouldPlayIntro({ ...base, reducedMotion: true })).toBe(true);
    expect(shouldPlayIntro({ ...base, reducedMotion: true, cold: true })).toBe(false);
  });
  it('calm mode: no cold-start intro (a user-triggered one still shows, as the calm fade)', () => {
    expect(shouldPlayIntro({ ...base, cold: true, calm: true })).toBe(false);
    expect(shouldPlayIntro({ ...base, cold: true, calm: false })).toBe(true);
    expect(shouldPlayIntro({ ...base, calm: true })).toBe(true);
  });
});

describe('shouldPlayIntroSound', () => {
  const s = { sound: true, soundExplicit: false, reducedMotion: false };
  it('plays after a gesture', () => expect(shouldPlayIntroSound(s)).toBe(true));
  it('never on cold start', () => expect(shouldPlayIntroSound({ ...s, cold: true })).toBe(false));
  it('off when disabled', () => expect(shouldPlayIntroSound({ ...s, sound: false })).toBe(false));
  it('reduced motion needs an explicit opt-in', () => {
    expect(shouldPlayIntroSound({ ...s, reducedMotion: true })).toBe(false);
    expect(shouldPlayIntroSound({ ...s, reducedMotion: true, soundExplicit: true })).toBe(true);
  });
});

describe('settings storage', () => {
  it('keys per profile with a global fallback', () => {
    expect(introKey('p1')).toBe('ff-intro:p1');
    expect(introKey('')).toBe('ff-intro:global');
    expect(introKey(null)).toBe('ff-intro:global');
  });
  it('parses defensively', () => {
    expect(parseIntroSettings(null)).toEqual(DEFAULT_INTRO);
    expect(parseIntroSettings('not json')).toEqual(DEFAULT_INTRO);
    expect(parseIntroSettings('42')).toEqual(DEFAULT_INTRO);
    expect(parseIntroSettings('{"show":false,"sound":true}')).toEqual({ show: false, sound: true, soundExplicit: true });
    expect(parseIntroSettings('{"show":"x","sound":false}')).toEqual({ show: true, sound: false, soundExplicit: false });
  });
  it('route helper', () => expect(isIntroFreeRoute('/watch/1')).toBe(true));
});
