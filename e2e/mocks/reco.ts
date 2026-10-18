// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Page } from '@playwright/test';
import { MOVIE, items } from './fixtures.js';

/** R4: answers of a server with RECO_ENGINE=v2 (reason on every item, engine on the rows) shared by reco-v2.spec.ts and its mobile twin. */
export const seed = { id: MOVIE.id, name: MOVIE.name };
export const reason = (...traits: string[]) => ({ seed, traits });
export const BECAUSE_ITEMS = items.slice(1, 8).map((i, n) => ({ ...i, reason: n === 0 ? reason('director:Ava Nolan', 'genre:Krimi') : reason('genre:Drama') }));
// four titles that none of the rows above shows (Bright Valley, items[8], is in Continue watching): the web drops a shorter extra row
export const MORE_ITEMS = [items[0]!, ...items.slice(9, 12)].map((i) => ({ ...i, reason: { seed: { id: items[7]!.id, name: items[7]!.name }, traits: ['together'] } }));

/** the home page of a v2 server: the "because" row with reasons, one more row, and the ranker's order */
export async function mockV2Home(page: Page) {
  await page.route('**/api/library/because', (r) => r.fulfill({ json: { because: { id: MOVIE.id, name: MOVIE.name, liked: true }, engine: 'v2', order: ['because', 'more:0'], items: BECAUSE_ITEMS } }));
  await page.route('**/api/library/because-more', (r) => r.fulfill({ json: { rows: [{ because: { id: items[7]!.id, name: items[7]!.name }, engine: 'v2', items: MORE_ITEMS }] } }));
}

/** post-play of a v2 server: the transition row ("what people watch after X"), a because row and a taste row, all with reasons */
export const V2_POSTPLAY = {
  state: 'movie_end', current: MOVIE, next: null, nextAirDate: null, sequel: null, canWish: false, remind: null, suggestions: true, engine: 'v2', hero: null,
  rows: [
    { kind: 'transition', title: MOVIE.name, reason: { seed }, engine: 'v2', recoRow: 'transition', items: items.slice(1, 6).map((i) => ({ ...i, reason: reason('next') })) },
    { kind: 'because', title: MOVIE.name, reason: { seed, traits: [] }, engine: 'v2', recoRow: 'postplay', items: items.slice(6, 11).map((i) => ({ ...i, reason: reason('director:Ava Nolan') })) },
    { kind: 'taste', title: '', reason: { traits: [] }, engine: 'v2', recoRow: 'top_picks', items: items.slice(2, 5).map((i) => ({ ...i, reason: { seed: null, traits: ['genre:Drama'] } })) },
  ],
};
export const V2_POSTPLAY_HERO = { ...V2_POSTPLAY, hero: { ...items[6]!, reason: reason('director:Ava Nolan') } };

/** a kids profile: the server sends no friends and no transition row */
export const V2_POSTPLAY_KIDS = { ...V2_POSTPLAY, rows: V2_POSTPLAY.rows.filter((r) => r.kind !== 'transition'), hero: null };
