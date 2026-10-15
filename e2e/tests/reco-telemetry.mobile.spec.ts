// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '../fixtures.js';
import { row } from '../helpers.js';

type Ev = { row: string; engine: string; impressions: number; clicks: number; dismisses: number };
const sent = (reco: unknown[]) => (reco as Array<{ events: Ev[] }>).flatMap((b) => b.events);

test.describe('home: recommendation telemetry (phone)', () => {
  test('a "because" row reports one impression and its clicks as counts, without any title', async ({ page, api }) => {
    await page.goto('/');
    const because = row(page, 'Weil du „Inkwell“ gesehen hast');
    await because.scrollIntoViewIfNeeded();
    await expect(because.locator('a[href]').first()).toBeVisible();
    await because.locator('a[href]').first().click();
    await expect.poll(() => sent(api.reco).filter((e) => e.row === 'because'), { timeout: 12_000 }).not.toEqual([]);
    const evs = sent(api.reco).filter((e) => e.row === 'because');
    expect(evs.reduce((n, e) => n + e.impressions, 0)).toBe(1);
    expect(evs.reduce((n, e) => n + e.clicks, 0)).toBe(1);
    expect(evs.every((e) => e.engine === 'v1')).toBe(true);
    // counts only: no item id, no title
    expect(JSON.stringify(api.reco)).not.toMatch(/Inkwell|[0-9a-f]{32}/);
    expect(JSON.stringify(api.reco)).toMatch(/"events"/);
  });
});
