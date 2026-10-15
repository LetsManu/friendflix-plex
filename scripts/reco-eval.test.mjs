// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests for scripts/reco-eval.mjs (node:test, run by `npm run test:scripts`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { ENGINES, K, cooccurrenceEngine, evaluate, format, listDiversity, main, parseArgs, popularityTiers, prepare, split, v1Engine, DEFAULT_FIXTURE } from './reco-eval.mjs';

const fixture = JSON.parse(readFileSync(DEFAULT_FIXTURE, 'utf8'));
const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const ev = (item, i, extra = {}) => ({ item, ts: 1000 + i, ...extra });
const prof = (id, items, extra = {}) => ({ id, events: items.map((x, i) => ev(x, i)), ...extra });

/** an engine that answers with fixed lists per profile history length, to check the metric arithmetic */
const stub = (home, next = home) => () => ({ name: 'stub', fit() {}, recommend: ({ surface, history }) => (surface === 'next' ? next : home)(history) });

test('leave-last-out: the last interaction is held out, short profiles and kids are skipped', () => {
  const prep = prepare({ profiles: [prof('a', ['1', '2', '3', '4']), prof('b', ['1', '2']), prof('k', ['1', '2', '3', '4'], { kids: true })] });
  const s = split(prep, 4);
  assert.equal(s.cases.length, 1);
  assert.equal(s.cases[0].target, '4');
  assert.deepEqual(s.cases[0].history.map((e) => e.item), ['1', '2', '3']);
  assert.equal(s.skipped, 1);
  assert.deepEqual(s.train.map((p) => p.id), ['a', 'b']); // the kids profile feeds nothing
  assert.deepEqual(s.train[0].seq.map((e) => e.item), ['1', '2', '3']); // the held-out title is not in train
});

test('events are ordered by time, deduplicated; dislikes are not interactions; likes are remembered', () => {
  const p = prepare({ profiles: [{ id: 'a', events: [ev('x', 5), ev('y', 1), ev('x', 9, { kind: 'like' }), ev('z', 3, { kind: 'dislike' })] }] }).profiles[0];
  assert.deepEqual(p.seq.map((e) => e.item), ['y', 'x']);
  assert.equal(p.seq[1].liked, true);
  assert.ok(p.disliked.has('z'));
});

test('metric arithmetic on hand-computed lists', () => {
  const fillers = Array.from({ length: 20 }, (_, i) => `f${i}`);
  const data = {
    items: [...['g1', 'g2', 'g3'], ...fillers].map((id) => ({ id })),
    profiles: [prof('a', ['h1', 'h2', 'h3', 'T1']), prof('b', ['h1', 'h2', 'i3', 'T2'])],
  };
  // profile a (last seen h3): target at rank 3. profile b (last seen i3): target at rank 12, outside the top 10
  const answer = (h) => (h[h.length - 1].item === 'h3' ? ['g1', 'h1', 'T1', 'g3'] : [...fillers.slice(0, 11), 'T2']);
  const r = evaluate(data, { engines: ['s'], registry: { s: stub(answer) }, minInteractions: 4 }).engines.s;
  near(r.hitRate, 0.5);
  near(r.ndcg, 0.5 / 2); // 1 / log2(3 + 1) = .5 for a, 0 for b
  near(r.mrr, (1 / 3 + 1 / 12) / 2);
  near(r.seenShare, 1 / 14); // a listed the seen h1 among 4, b listed 10 unseen titles
  near(r.coverage, 14 / 29); // g1 h1 T1 g3 + f0..f9, of 3 + 20 + h1 h2 h3 i3 T1 T2
  assert.equal(r.hits, 1);
  assert.equal(r.midPopularityShare, 0); // the one hit (T1) was never played by anyone else: a tail title
});

test('catalog coverage, diversity, tiers, cold-start and transition accuracy', () => {
  const data = {
    items: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((id, n) => ({ id, genres: n < 5 ? ['p'] : ['q'] })),
    profiles: [
      prof('1', ['a', 'b', 'c']), prof('2', ['a', 'b', 'd']), prof('3', ['a', 'c', 'd']), prof('4', ['a', 'b', 'e']), prof('5', ['a', 'c', 'b']),
      prof('6', ['a', 'b', 'j']),
    ],
  };
  // everyone gets the same answer: j, b, f (genres q, p, q); the next-title surface answers b
  const reg = { s: stub(() => ['j', 'b', 'f'], () => ['b']) };
  const r = evaluate(data, { engines: ['s'], registry: reg, minInteractions: 3 }).engines.s;
  near(r.coverage, 3 / 10);
  assert.equal(r.coldCases, 4); // targets c, d, d, e, b, j: d (twice), e and j have no other watcher once held out
  near(r.newTitleHitRate, 1 / 4); // only j is in the list
  near(r.transitionAccuracy, 1 / 6); // b is the real next title of profile 5 only
  near(r.diversity, 2 / 3); // pairs j-b 1, j-f 0, b-f 1
  const feats = new Map(data.items.map((i) => [i.id, i]));
  near(listDiversity(['a', 'f'], feats), 1);
  assert.equal(listDiversity(['a'], feats), null);
  assert.equal(listDiversity(['a', 'zz'], feats), null); // items without genres are ignored
  const t = popularityTiers(new Set('abcdefghij'), new Map([['a', 9], ['b', 8], ['c', 7], ['d', 6], ['e', 5]]));
  const count = (x) => [...t.values()].filter((v) => v === x).length;
  assert.deepEqual([count('head'), count('mid'), count('tail')], [2, 3, 5]);
  assert.equal(t.get('a'), 'head');
  assert.equal(t.get('j'), 'tail');
});

test('mid-popularity share counts the tiers of the hits only', () => {
  // nine short profiles (below the minimum, so they only feed popularity) give a, b, c 9, 8, 7 viewers: head = a, b; mid = c, f, g
  const shorts = Array.from({ length: 9 }, (_, i) => prof(`s${i}`, ['a', 'b', 'c'].filter((_x, n) => i < 9 - n)));
  const data = {
    items: 'abcdefghij'.split('').map((id) => ({ id })),
    profiles: [...shorts, prof('p1', ['f', 'g', 'h', 'c']), prof('p2', ['f', 'g', 'i', 'a'])],
  };
  // a (head) is hit for p2, c (mid) for p1 -> half of the hits are mid-popularity
  const r = evaluate(data, { engines: ['s'], registry: { s: stub(() => ['c', 'a']) }, minInteractions: 4 }).engines.s;
  assert.equal(r.hits, 2);
  near(r.midPopularityShare, 0.5);
});

test('exclude-seen removes played titles from every engine', () => {
  const data = { profiles: [prof('1', ['a', 'b', 'c', 'd']), prof('2', ['a', 'b', 'c', 'd'])] };
  const reg = { s: stub((h) => [h[0].item, 'zz']) };
  assert.equal(evaluate(data, { engines: ['s'], registry: reg, minInteractions: 4 }).engines.s.seenShare, 0.5);
  assert.equal(evaluate(data, { engines: ['s'], registry: reg, minInteractions: 4, excludeSeen: true }).engines.s.seenShare, 0);
});

test('v1 follows libraryBecause: latest like (else last title) as the seed, recorded similar() first, no seen filter, dislikes out', () => {
  const prep = prepare({
    items: [{ id: 'a', genres: ['x'] }, { id: 'b', genres: ['x'] }, { id: 'c', genres: ['x'] }, { id: 'd', genres: ['y'] }],
    profiles: [{ id: 'p', events: [ev('a', 1, { kind: 'like' }), ev('d', 2), ev('b', 3, { kind: 'dislike' })] }],
    similar: { a: ['c', 'b', 'd', 'a'] },
  });
  const e = v1Engine();
  e.fit(null, prep);
  const p = prep.profiles[0];
  assert.deepEqual(e.recommend({ history: p.seq, disliked: p.disliked }), ['c', 'd']); // seed a (liked), b disliked, seed itself dropped, d (seen) kept
  // no like: the last title is the seed; 'd' has no recorded entry -> emulated over genres (nobody shares 'y')
  assert.deepEqual(e.recommend({ history: [{ item: 'd', liked: false }], disliked: new Set() }), []);
  assert.deepEqual(e.recommend({ history: [{ item: 'b', liked: false }], disliked: new Set() }), ['a', 'c']); // emulated: same genre, closer year ties by id
});

test('co-occurrence needs a pair in at least two profiles and never returns seen titles', () => {
  const mk = (id, items) => ({ id, seq: items.map((item) => ({ item })) });
  const train = { profiles: [mk('1', ['a', 'b', 'c']), mk('2', ['a', 'b']), mk('3', ['a', 'z'])] };
  const e = cooccurrenceEngine();
  e.fit(train);
  const hist = [{ item: 'a' }];
  assert.deepEqual(e.recommend({ surface: 'home', history: hist, seed: 'a' }), ['b']); // a-c and a-z come from one profile only
  assert.deepEqual(e.recommend({ surface: 'home', history: [{ item: 'a' }, { item: 'b' }], seed: 'b' }), []); // c is a single-profile pair too
  assert.deepEqual(e.recommend({ surface: 'next', history: hist, seed: 'a' }), ['b']);
});

test('fixture: baselines behave as designed', () => {
  const r = evaluate(fixture, {});
  assert.ok(r.meta.evaluatedProfiles >= 30);
  assert.ok(r.meta.skippedProfiles >= 1);
  const { popularity: pop, v1, cooccurrence: co } = r.engines;
  assert.ok(co.ndcg > pop.ndcg, 'co-occurrence beats popularity');
  assert.ok(co.ndcg > v1.ndcg, 'co-occurrence beats the emulated v1 on this fixture');
  assert.ok(co.transitionAccuracy > pop.transitionAccuracy);
  assert.equal(pop.seenShare, 0);
  assert.equal(co.seenShare, 0);
  assert.ok(v1.seenShare > 0, 'v1 does not filter played titles');
  assert.ok(v1.coldCases > 0 && v1.newTitleHitRate > 0, 'similar() reaches titles nobody has played');
  assert.equal(pop.newTitleHitRate, 0);
  assert.equal(co.newTitleHitRate, 0);
  assert.ok(co.midPopularityShare > pop.midPopularityShare);
  for (const m of Object.values(r.engines)) for (const k of ['hitRate', 'ndcg', 'mrr', 'coverage', 'diversity', 'seenShare', 'transitionAccuracy']) assert.ok(m[k] >= 0 && m[k] <= 1, k);
  assert.ok(K === 10);
});

test('fixture: deterministic, and the kids profile never changes the numbers', () => {
  assert.deepEqual(evaluate(fixture, {}), evaluate(fixture, {}));
  const noKids = { ...fixture, profiles: fixture.profiles.filter((p) => !p.kids) };
  assert.deepEqual(evaluate(noKids, {}).engines, evaluate(fixture, {}).engines);
  assert.ok(fixture.profiles.some((p) => p.kids));
});

test('plugs in another engine through the registry; unknown engines and too few profiles are refused', () => {
  const r = evaluate(fixture, { engines: ['mine'], registry: { ...ENGINES, mine: stub(() => []) } });
  assert.equal(r.engines.mine.hitRate, 0);
  assert.throws(() => evaluate(fixture, { engines: ['nope'] }), /unknown engine/);
  assert.throws(() => evaluate({ profiles: [prof('a', ['1', '2'])] }, { minProfiles: 5 }), /need 5/);
});

test('CLI: prints aggregates only, never item or profile ids', async () => {
  const lines = [];
  assert.equal(await main([], {}, (s) => lines.push(s)), 0);
  const out = lines.join('\n');
  assert.match(out, /HitRate@10/);
  assert.match(out, /Transition accuracy/);
  const json = [];
  await main(['--json', '--engines', 'popularity,cooccurrence'], {}, (s) => json.push(s));
  const parsed = JSON.parse(json.join('\n'));
  assert.deepEqual(Object.keys(parsed.engines), ['popularity', 'cooccurrence']);
  const text = out + json.join('\n');
  for (const id of [...fixture.items.map((i) => i.id), ...fixture.profiles.map((p) => p.id)]) assert.ok(!new RegExp(`\\b${id}\\b`).test(text), `leaked ${id}`);
  assert.equal(format(parsed).includes('cooccurrence'), true);
});

test('CLI: argument handling', async () => {
  assert.deepEqual(parseArgs(['--db', '--exclude-seen', '--min-profiles', '7', '--engines', 'v1,popularity']), { engines: ['v1', 'popularity'], minProfiles: 7, db: true, excludeSeen: true });
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  await assert.rejects(main(['--db'], {}, () => {}), /DATABASE_URL/);
  const help = [];
  await main(['--help'], {}, (s) => help.push(s));
  assert.match(help[0], /usage/);
  // the default gate: the fixture has far more than 5 evaluable profiles, a dataset with 2 does not pass
  await assert.rejects(main(['--data', new URL('./fixtures/reco-eval.json', import.meta.url).pathname, '--min-profiles', '1000'], {}, () => {}), /need 1000/);
});
