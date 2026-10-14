// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from './i18n';
import { pollDelay, voteError } from './polls';

afterEach(async () => { await setLocale('de'); });

describe('pollDelay', () => {
  it('polls every 15 s while healthy', () => expect(pollDelay(0)).toBe(15_000));
  it('backs off and stops after repeated failures', () => {
    expect(pollDelay(1)).toBe(30_000);
    expect(pollDelay(3)).toBe(120_000);
    expect(pollDelay(5)).toBeNull();
  });
});

describe('voteError', () => {
  it('maps a closed poll', () => expect(voteError({ status: 409, body: { error: 'poll_closed_or_option_invalid' } })).toBe('Abstimmung ist beendet.'));
  it('maps everything else to a generic message', () => {
    expect(voteError({ status: 500, body: null })).toMatch(/nicht gespeichert/);
    expect(voteError(new TypeError('network'))).toMatch(/nicht gespeichert/);
  });
  it('follows the UI language', async () => {
    await setLocale('en');
    expect(voteError({ status: 409, body: { error: 'poll_closed_or_option_invalid' } })).toBe('The poll has ended.');
  });
});
