// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { BRAND_NAME, brandTitle } from '../src/brand.js';
import { pushExternal } from '../src/notify.js';
import { buildPayload } from '../src/push.js';

describe('fork branding of outgoing messages', () => {
  it('names the product "FriendFlix for Plex"', () => {
    expect(BRAND_NAME).toBe('FriendFlix for Plex');
  });

  it('brandTitle prefixes the product name once', () => {
    expect(brandTitle('Neue Folge: X')).toBe('FriendFlix for Plex – Neue Folge: X');
    expect(brandTitle('')).toBe(BRAND_NAME);
    expect(brandTitle(BRAND_NAME)).toBe(BRAND_NAME);
  });

  it('ntfy Title header and Discord text carry the brand', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => { calls.push({ url: String(url), init: init ?? {} }); return new Response('ok'); }) as typeof fetch;
    const cfg = { NTFY_URL: 'https://ntfy.example.com/ff', DISCORD_WEBHOOK_URL: 'https://discord.example.com/hook' } as never;
    await pushExternal({ cfg, fetchImpl }, { title: 'Download bereit', body: 'Dune', link: '/item/1' });
    const ntfy = calls.find((c) => c.url.startsWith('https://ntfy.'))!;
    expect(decodeURIComponent(String((ntfy.init.headers as Record<string, string>).Title))).toBe('FriendFlix for Plex – Download bereit');
    const discord = calls.find((c) => c.url.startsWith('https://discord.'))!;
    expect(JSON.parse(String(discord.init.body)).content).toBe('FriendFlix for Plex – Download bereit\nDune');
  });

  it('the neutral Web Push title (non-owner profiles) is the product name', () => {
    expect(buildPayload({ kind: 'available', title: 'secret', body: null }, false, 'en').title).toBe('FriendFlix for Plex');
  });
});
