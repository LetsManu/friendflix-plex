// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fork: the R0 recommendation evaluation (scripts/reco-eval.mjs --db) on a Plex instance. The script reads only FriendFlix's own
 * tables (profiles, play_seconds, thumbs, ratings), so Plex item ids (9f1e…) pass through unchanged; the item features come from
 * the Plex mirror with the SQL documented in docs/plex.md (checked here against the id codec). The read is read-only.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodePlexId } from '../../src/plex/ids.js';
import { provisionUser } from '../../src/users.js';
import { TEST_DB, makeEnv, type TestEnv } from '../helpers.js';
import { PlexFake } from '../plexfake.js';

/** docs/plex.md "Recommendation measurement on Plex": item features (id, year, genres) of the mirror, as --items JSON */
const PLEX_ITEMS_SQL = `select coalesce(json_agg(json_build_object(
  'id', '9f1e0' || lpad(to_hex(i.rating_key), 27, '0'),
  'year', i.year,
  'genres', coalesce((select json_agg(t.tag order by t.tag) from plex_tags t where t.rating_key = i.rating_key and t.kind = 'genre'), '[]'::json)
)), '[]'::json) as items from plex_items i where i.type in ('movie', 'show')`;

describe('reco-eval on Plex', () => {
  let env: TestEnv;
  const dir = mkdtempSync(join(tmpdir(), 'ff-reco-plex-'));
  const fake = new PlexFake();
  const genres = [['Drama'], ['Comedy'], ['Drama', 'Crime'], ['Animation', 'Family'], ['Comedy', 'Romance']];
  const keys = Array.from({ length: 30 }, (_, i) => fake.addMovie({ title: `Reco ${i}`, genres: genres[i % genres.length]!, year: 2000 + (i % 15) }));

  beforeAll(async () => { env = await makeEnv({}, { server: 'plex', plexFake: fake }); }, 60_000);
  afterAll(async () => { rmSync(dir, { recursive: true, force: true }); await env.close(); });

  it('the documented items SQL yields the FriendFlix ids of the mirror with their genres', async () => {
    const items = (await env.pool.query<{ items: Array<{ id: string; year: number | null; genres: string[] }> }>(PLEX_ITEMS_SQL)).rows[0]!.items;
    for (const k of keys) {
      const it = items.find((x) => x.id === encodePlexId('item', k));
      expect(it, k).toBeTruthy();
      expect(it!.genres.length).toBeGreaterThan(0);
    }
  });

  it('--db reads Plex-id interactions read-only and evaluates every engine', async () => {
    // six people with twelve finished titles each (day resolution, >= 120 s), overlapping so co-occurrence has support
    for (let p = 0; p < 6; p++) {
      const u = await provisionUser(env.ctx, { sub: `reco-plex-${p}`, email: `reco${p}@example.com`, name: `Reco ${p}`, groups: [] }, 'friend');
      for (let j = 0; j < 12; j++) {
        const rk = keys[(p * 3 + j) % keys.length]!;
        const day = new Date(Date.UTC(2026, 8, 1 + j)).toISOString().slice(0, 10);
        await env.pool.query('insert into play_seconds(user_id, item_id, day, seconds, item_name) values ($1,$2,$3,600,$4)', [u.id, encodePlexId('item', rk), day, `Reco ${rk}`]);
      }
    }
    const items = (await env.pool.query(PLEX_ITEMS_SQL)).rows[0]!.items;
    const file = join(dir, 'items.json');
    writeFileSync(file, JSON.stringify(items));
    const before = (await env.pool.query('select count(*)::int n from play_seconds')).rows[0].n;
    const mod: any = await import(new URL('../../../scripts/reco-eval.mjs', import.meta.url).href);
    const out: string[] = [];
    expect(await mod.main(['--db', '--items', file, '--json', '--min-profiles', '1'], { DATABASE_URL: TEST_DB }, (s: string) => out.push(s))).toBe(0);
    const res = JSON.parse(out.join('\n'));
    expect(res.meta.evaluatedProfiles).toBe(6);
    expect(Object.keys(res.engines).sort()).toEqual(['cooccurrence', 'popularity', 'v1']);
    for (const e of Object.values(res.engines) as Array<{ hitRate: number | null }>) expect(e.hitRate).not.toBeNull();
    // aggregates only: no item id or title in the output
    for (const k of keys) expect(out.join('\n')).not.toContain(encodePlexId('item', k));
    expect(out.join('\n')).not.toContain('Reco ');
    expect((await env.pool.query('select count(*)::int n from play_seconds')).rows[0].n).toBe(before);
  });
});
