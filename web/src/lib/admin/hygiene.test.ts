// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { hasKey } from '#lib/i18n';
import { CATEGORIES, ISSUE_CODES, categoryOf, codesOf, hygieneQuery, issueHint, issueLabel, rowTitle } from './hygiene';

describe('hygiene view helpers', () => {
  it('hygieneQuery drops empty filters and keeps sort/dir/offset/limit', () => {
    const q = hygieneQuery({ category: '', issue: undefined, type: '', seriesId: '', q: '  ', sort: 'name', dir: 'asc', offset: 0, limit: 50 });
    expect(Object.fromEntries(q)).toEqual({ sort: 'name', dir: 'asc', offset: '0', limit: '50' });
    const r = hygieneQuery({ category: 'language', issue: 'foreign_no_subs', type: 'Episode', seriesId: 'abc', q: ' dune ', sort: 'size', dir: 'desc', offset: 100, limit: 25 });
    expect(Object.fromEntries(r)).toEqual({ category: 'language', issue: 'foreign_no_subs', type: 'Episode', seriesId: 'abc', q: 'dune', sort: 'size', dir: 'desc', offset: '100', limit: '25' });
    expect(Object.fromEntries(hygieneQuery({ q: '', sort: 'issues', offset: 0, limit: 10 }))).toEqual({ sort: 'issues', offset: '0', limit: '10' });
  });

  it('every IssueCode has a label and a hint (exhaustive list) and a category', () => {
    expect(ISSUE_CODES).toHaveLength(19);
    for (const c of ISSUE_CODES) {
      expect(hasKey(issueLabel(c)), c).toBe(true);
      expect(hasKey(issueHint(c)), c).toBe(true);
      expect(CATEGORIES).toContain(categoryOf(c));
    }
    for (const c of CATEGORIES) expect(hasKey(`adminContent.hygiene.cat.${c}`), c).toBe(true);
    expect(codesOf('duplicate')).toEqual(['dup_ids', 'dup_title', 'dup_episode']);
    expect(codesOf(null)).toHaveLength(19);
  });

  it('rowTitle: episodes show their series first', () => {
    expect(rowTitle({ type: 'Episode', name: 'Pilot', seriesName: 'Sundial' })).toBe('Sundial · Pilot');
    expect(rowTitle({ type: 'Movie', name: 'Hearth', seriesName: null })).toBe('Hearth');
  });
});
