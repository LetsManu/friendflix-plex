import { expect, test } from '../fixtures.js';
import { items } from '../mocks/fixtures.js';
import { row } from '../helpers.js';

test.describe('home: more "Weil du ... geschaut hast" rows', () => {
  test('are interleaved between the other rows, not stacked, and never repeat titles of the first rows', async ({ page }) => {
    const rows = [
      { because: { id: 'a', name: 'Dunmoor' }, items: items.slice(3, 7) },
      { because: { id: 'b', name: 'Arbor' }, items: items.slice(7, 12) }, // items[8] is the series of a "Weiterschauen" episode and dropped: 4 titles are left
      { because: { id: 'c', name: 'Tamarind' }, items: items.slice(0, 4) }, // < 4 titles are left once duplicates are removed: hidden
    ];
    await page.route('**/api/hubs', (r) => r.fulfill({ json: { hubs: [] } })); // brand hubs are covered by their own spec
    await page.route('**/api/library/because', (r) => r.fulfill({ json: { because: { name: 'Inkwell' }, items: items.slice(0, 2) } }));
    await page.route('**/api/library/because-more', (r) => r.fulfill({ json: { rows } }));
    await page.goto('/');
    const a = row(page, 'Weil du „Dunmoor“ geschaut hast'), b = row(page, 'Weil du „Arbor“ geschaut hast');
    await expect(a).toBeAttached();
    await expect(b).toBeAttached();
    await expect(row(page, 'Weil du „Tamarind“ geschaut hast')).toHaveCount(0);
    // rows are separated by at least one other row
    const order = await page.locator('section.row h2').allTextContents();
    const i = order.findIndex((x) => x.includes('Dunmoor')), j = order.findIndex((x) => x.includes('Arbor'));
    expect(j - i).toBeGreaterThan(1);
    // the extra rows never repeat titles of "Weiterschauen" (item 3 is in there)
    await expect(a.getByRole('link', { name: new RegExp(items[2]!.name) })).toHaveCount(0);
  });
});

test.describe('watch party: live reactions', () => {
  // the mocked video file does not exist: the browser logs the failed media request (the player retries, no page error)
  test.use({ allowedConsole: /Failed to load resource/ });
  test('the bar sends a reaction and the emoji floats over the picture with the sender name', async ({ page, api: _api }) => {
    const sent: unknown[] = [];
    await page.routeWebSocket(/\/ws\/party\//, (ws) => {
      ws.send(JSON.stringify({ t: 'welcome', you: 'u1', hostId: 'u1', mode: 'host', itemId: items[0]!.id, title: 'Testfilm', members: [{ id: 'u1', name: 'Mia', buffering: false }], state: { playing: false, position: 0, at: Date.now(), hold: false }, serverNow: Date.now() }));
      ws.onMessage((m) => {
        const msg = JSON.parse(String(m));
        if (msg.t === 'react') { sent.push(msg); ws.send(JSON.stringify({ t: 'react', from: 'u1', name: 'Mia', emoji: msg.emoji })); }
        if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() }));
      });
    });
    // the player behind the party page: just enough playback endpoints so that it mounts (the video itself never loads)
    // (Playwright tries the most recently added route first: the catch-all goes first so that /info gets its own answer)
    await page.route('**/api/playback/**', (r) => r.fulfill({ status: 204 }));
    await page.route('**/api/playback/info', (r) => r.fulfill({ json: { directUrl: '/media/none.mp4', hlsUrl: '', resumeTicks: 0, mediaSourceId: 'ms1', playSessionId: 'ps1', maxBitrate: 60_000_000, roleMaxBitrate: 60_000_000, subtitles: [], audioTracks: [] } }));
    await page.route('**/api/bookmarks?*', (r) => r.fulfill({ json: { bookmarks: [] } }));
    await page.route('**/api/items/*/segments', (r) => r.fulfill({ json: { segments: [] } }));
    await page.goto('/party/room1');
    const bar = page.getByRole('group', { name: 'Live-Reaktionen' });
    await expect(bar.getByRole('button')).toHaveCount(6);
    await bar.getByRole('button', { name: 'Reaktion 🔥 senden' }).click();
    await expect.poll(() => sent.length).toBe(1);
    await expect(page.locator('.floats .fl').first()).toContainText('Mia');
    await expect(page.locator('.floats .fl').first()).toContainText('🔥');
    await expect(page.locator('.floats .fl')).toHaveCount(0, { timeout: 5000 }); // gone after ~2.5 s
  });
});
