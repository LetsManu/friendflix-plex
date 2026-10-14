// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { kitVersionName } from './kit-version';

describe('kitVersionName', () => {
  const clock = () => 1234;
  it('prefers the git commit', () => {
    expect(kitVersionName({ GIT_SHA: 'abc123', SOURCE_DATE_EPOCH: '1700000000' }, clock)).toBe('abc123');
  });
  it('falls back to SOURCE_DATE_EPOCH when there is no real sha', () => {
    expect(kitVersionName({ GIT_SHA: 'dev', SOURCE_DATE_EPOCH: '1700000000' }, clock)).toBe('1700000000');
    expect(kitVersionName({ GIT_SHA: ' ', SOURCE_DATE_EPOCH: '1700000000' }, clock)).toBe('1700000000');
  });
  it('uses the clock only without any build input', () => {
    expect(kitVersionName({}, clock)).toBe('1234');
    expect(kitVersionName({ SOURCE_DATE_EPOCH: 'yesterday' }, clock)).toBe('1234');
  });
  it('is stable for the same inputs', () => {
    const env = { GIT_SHA: 'deadbeef' };
    expect(kitVersionName(env, () => 1)).toBe(kitVersionName(env, () => 2));
  });
});
