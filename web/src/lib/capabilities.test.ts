// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { ALL_CAPS, capsFrom, linkShown, segmentShown, serverCaps } from './capabilities';

describe('server capabilities', () => {
  it('default: everything supported (before /api/me, older backends)', () => {
    expect(get(serverCaps)).toEqual(ALL_CAPS);
    expect(capsFrom(undefined)).toEqual(ALL_CAPS);
    expect(capsFrom(null)).toEqual(ALL_CAPS);
    expect(capsFrom('x')).toEqual(ALL_CAPS);
    for (const s of ['intro', 'outro', 'recap', 'preview', 'Intro']) expect(segmentShown(ALL_CAPS, s)).toBe(true);
    expect(linkShown(ALL_CAPS, '/calendar')).toBe(true);
  });
  it('the Jellyfin answer changes nothing', () => {
    const jf = { segments: ['intro', 'outro', 'recap', 'preview'], trickplay: true, upcoming: true, subtitleSearch: true, webhooks: true, changeFeed: false, planB: true, subtitleExtract: false, chapters: true };
    expect(capsFrom(jf)).toEqual(ALL_CAPS);
  });
  it('a reduced server hides exactly what it lacks', () => {
    const c = capsFrom({ segments: ['intro', 'outro', 7], upcoming: false, subtitleSearch: false, trickplay: 'yes' });
    expect(c.segments).toEqual(['intro', 'outro']);
    expect(segmentShown(c, 'recap')).toBe(false);
    expect(segmentShown(c, 'preview')).toBe(false);
    expect(segmentShown(c, 'intro')).toBe(true);
    expect(c.subtitleSearch).toBe(false);
    expect(c.trickplay).toBe(true); // malformed: keeps the default
    expect(linkShown(c, '/calendar')).toBe(false);
    expect(linkShown(c, '/upcoming')).toBe(true); // Seerr upcoming, not the media server
  });
  it('chapters: supported unless the server says no (older backends send nothing)', () => {
    expect(capsFrom({}).chapters).toBe(true);
    expect(capsFrom({ chapters: false }).chapters).toBe(false);
    expect(capsFrom({ chapters: 'no' }).chapters).toBe(true);
  });
});
