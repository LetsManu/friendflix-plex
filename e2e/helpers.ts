// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Locator, type Page } from '@playwright/test';

/** Row section by its accessible name (e.g. "Weiterschauen"). */
export const row = (page: Page, title: string | RegExp): Locator => page.locator('section.row').filter({ has: page.getByRole('heading', { level: 2, name: title }) });

/** True when the page has no horizontal scrollbar. */
export const noHorizontalOverflow = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

/** Hovers a desktop card and waits for the portal pop-out (ready = positioned and visible). */
export async function openPopout(page: Page, card: Locator): Promise<Locator> {
  await card.scrollIntoViewIfNeeded();
  await card.hover();
  const hp = page.locator('.hp.ready');
  await expect(hp).toBeVisible();
  return hp;
}

export async function boxInViewport(page: Page, el: Locator): Promise<{ ok: boolean; box: { x: number; y: number; width: number; height: number } | null; vw: number; vh: number }> {
  const box = await el.boundingBox();
  const { vw, vh } = await page.evaluate(() => ({ vw: window.innerWidth, vh: window.innerHeight }));
  const ok = !!box && box.x >= -0.5 && box.y >= -0.5 && box.x + box.width <= vw + 0.5 && box.y + box.height <= vh + 0.5;
  return { ok, box, vw, vh };
}
