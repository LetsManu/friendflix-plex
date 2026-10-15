// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.js';

/** /api/restore: GET answers `state`, POST answers `post` (status + body) and records that it was called with JSON */
async function mockRestore(page: Page, state: object, post: { status: number; body: object } = { status: 200, body: { ok: true } }) {
  const posts: (string | null)[] = [];
  await page.route('**/api/restore', (r) => {
    if (r.request().method() === 'DELETE') {
      posts.push('DELETE');
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    if (r.request().method() === 'POST') {
      posts.push(r.request().headers()['content-type'] ?? null);
      return r.fulfill({ status: post.status, contentType: 'application/json', body: JSON.stringify(post.body) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state) });
  });
  return posts;
}

test.describe('restore after sign-in (/restore)', () => {
  test('/restore restores and offers sign in', async ({ page }) => {
    const posts = await mockRestore(page, { state: 'scheduled', deletionAt: '2026-10-21T12:00:00.000Z' });
    await page.goto('/restore');
    await expect(page.getByRole('heading', { level: 1, name: 'Dein Konto wird gelöscht' })).toBeVisible();
    await expect(page.getByText('Dein Konto wird am 21. Oktober 2026 gelöscht. Möchtest du es wiederherstellen?')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Löschung beibehalten' })).toBeVisible();
    await page.getByRole('button', { name: 'Konto wiederherstellen' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Konto wiederhergestellt' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Anmelden' })).toHaveAttribute('href', '/auth/login');
    expect(posts).toEqual(['application/json']);
  });

  test('keep the deletion stays on the page (no login loop) and drops the cookie', async ({ page }) => {
    const calls = await mockRestore(page, { state: 'scheduled', deletionAt: '2026-10-21T12:00:00.000Z' });
    await page.goto('/restore');
    await page.getByRole('button', { name: 'Löschung beibehalten' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Löschung bleibt bestehen' })).toBeVisible();
    await expect(page.getByText('Dein Konto wird am 21. Oktober 2026 gelöscht. Du kannst diese Seite jetzt schließen.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Anmelden' })).toHaveCount(0);
    await expect.poll(() => calls).toEqual(['DELETE']);
    expect(new URL(page.url()).pathname).toBe('/restore');
  });

  test('ended access: restored but still locked, no sign-in offered', async ({ page }) => {
    await mockRestore(page, { state: 'scheduled', deletionAt: '2026-10-21T12:00:00.000Z' }, { status: 200, body: { ok: true, accessEnded: true } });
    await page.goto('/restore');
    await page.getByRole('button', { name: 'Konto wiederherstellen' }).click();
    await expect(page.getByText(/Dein Zugang ist aber abgelaufen/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Anmelden' })).toHaveCount(0);
  });

  test.describe('failures', () => {
    test.use({ allowedConsole: /status of (401|409)/ });

    test('the claim won: deletion already running', async ({ page }) => {
      await mockRestore(page, { state: 'scheduled', deletionAt: '2026-10-21T12:00:00.000Z' }, { status: 409, body: { error: 'deletion_in_progress' } });
      await page.goto('/restore');
      await page.getByRole('button', { name: 'Konto wiederherstellen' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Löschung läuft bereits' })).toBeVisible();
    });

    test('an expired cookie shows "nothing to restore" and stays on the page', async ({ page }) => {
      await mockRestore(page, { state: 'scheduled', deletionAt: '2026-10-21T12:00:00.000Z' }, { status: 401, body: { error: 'unauthenticated' } });
      await page.goto('/restore');
      await page.getByRole('button', { name: 'Konto wiederherstellen' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Nichts wiederherzustellen' })).toBeVisible();
      expect(new URL(page.url()).pathname).toBe('/restore');
    });
  });

  test('no cookie: nothing to restore, sign in again', async ({ page }) => {
    await mockRestore(page, { state: 'none' });
    await page.goto('/restore');
    await expect(page.getByRole('heading', { level: 1, name: 'Nichts wiederherzustellen' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Anmelden' })).toHaveAttribute('href', '/auth/login');
  });
});
