// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { autoStartAllowed, countdownLabel, interactionCancels, isTextEntry, previewDone, type AutoStartEnv } from './autostart';

const base: AutoStartEnv = { pref: true, touch: false, tv: false, hidden: false, reducedMotion: false, previewing: true, hasTarget: true, cancelled: false };

describe('autoStartAllowed', () => {
  it('runs only with a playing preview, a target, a visible tab and the pref on (missing = on)', () => {
    expect(autoStartAllowed(base)).toBe(true);
    expect(autoStartAllowed({ ...base, pref: undefined })).toBe(true);
    expect(autoStartAllowed({ ...base, pref: false })).toBe(false);
    expect(autoStartAllowed({ ...base, previewing: false })).toBe(false);
    expect(autoStartAllowed({ ...base, hasTarget: false })).toBe(false);
    expect(autoStartAllowed({ ...base, hidden: true })).toBe(false);
  });
  it('never on touch, TV, reduced motion or after cancelling', () => {
    expect(autoStartAllowed({ ...base, touch: true })).toBe(false);
    expect(autoStartAllowed({ ...base, tv: true })).toBe(false);
    expect(autoStartAllowed({ ...base, reducedMotion: true })).toBe(false);
    expect(autoStartAllowed({ ...base, calm: true })).toBe(false); // calm mode (profile pref)
    expect(autoStartAllowed({ ...base, calm: false })).toBe(true);
    expect(autoStartAllowed({ ...base, cancelled: true })).toBe(false);
  });
});

describe('never interrupts active use', () => {
  it('does not arm with an open popover, a focused text field or a trailer the viewer started', () => {
    expect(autoStartAllowed({ ...base, popoverOpen: false, typing: false, userStartedPreview: false })).toBe(true);
    expect(autoStartAllowed({ ...base, popoverOpen: true })).toBe(false);
    expect(autoStartAllowed({ ...base, typing: true })).toBe(false);
    expect(autoStartAllowed({ ...base, userStartedPreview: true })).toBe(false);
  });
  it('pointer, key and wheel always cancel; focus only during the countdown; the overlay never', () => {
    for (const t of ['pointerdown', 'keydown', 'wheel']) {
      expect(interactionCancels(t, false, false)).toBe(true);
      expect(interactionCancels(t, false, true)).toBe(true);
      expect(interactionCancels(t, true, true)).toBe(false);
    }
    expect(interactionCancels('focusin', false, false)).toBe(false); // initial autofocus of the dialog
    expect(interactionCancels('focusin', false, true)).toBe(true);
    expect(interactionCancels('focusin', true, true)).toBe(false);
    expect(interactionCancels('pointermove', false, true)).toBe(false);
  });
  it('recognises text entry elements', () => {
    expect(isTextEntry({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT' })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT', type: 'search' })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTextEntry({ tagName: 'SELECT' })).toBe(true);
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTextEntry({ tagName: 'BUTTON' })).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe('previewDone / countdownLabel', () => {
  it('ended or 25 s', () => {
    expect(previewDone(true, 3)).toBe(true);
    expect(previewDone(false, 24.9)).toBe(false);
    expect(previewDone(false, 25)).toBe(true);
    expect(previewDone(false, NaN)).toBe(false);
  });
  it('labels', () => {
    expect(countdownLabel('episode', 4.2)).toBe('Folge startet in 5 …');
    expect(countdownLabel('movie', 0)).toBe('Film startet in 0 …');
  });
});
