// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests for scripts/reco-eval.mjs (node:test, run by `npm run test:scripts`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ABLATION_COMPONENTS, DEFAULT_DIST, ENGINES, K, ablation, ablationEpsilon, cooccurrenceEngine, evaluate, format, formatAblation, formatIpw, gate, ipwReplay, listDiversity, loadV2, main, parseArgs, popularityTiers, prepare, runEngine, split, v1Engine, v2Engine, DEFAULT_FIXTURE } from './reco-eval.mjs';

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

// ---------------------------------------------------------------------------------------------------------------- engine v2 (R2)

// v2 is the compiled backend (backend/src/reco/offline.ts). Use the build that is there, else compile one into a temp directory.
const root = fileURLToPath(new URL('..', import.meta.url));
let dist = process.env.RECO_EVAL_DIST || DEFAULT_DIST;
let v2mod = await loadV2(dist);
if (!v2mod) {
  dist = mkdtempSync(join(tmpdir(), 'ff-reco-dist-'));
  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'backend', 'tsconfig.json'), '--outDir', dist], { stdio: 'inherit' });
  v2mod = await loadV2(dist);
}
const registry = { ...ENGINES, v2: () => v2Engine(v2mod) };

test('v2: evaluated next to every baseline, deterministic, beats popularity and v1 on the fixture', () => {
  const a = evaluate(fixture, { registry, engines: Object.keys(registry) });
  assert.deepEqual(Object.keys(a.engines), ['popularity', 'v1', 'cooccurrence', 'v2']);
  assert.deepEqual(a, evaluate(fixture, { registry, engines: Object.keys(registry) }));
  const { v2, popularity, v1, cooccurrence } = a.engines;
  assert.ok(v2.ndcg > popularity.ndcg && v2.ndcg > v1.ndcg && v2.ndcg > cooccurrence.ndcg, JSON.stringify(a.engines));
  assert.ok(v2.hitRate > 0.5);
  assert.ok(v2.newTitleHitRate > cooccurrence.newTitleHitRate, 'content features reach titles nobody has watched');
});

test('v2: never recommends a disliked title; --exclude-seen leaves the already-seen share at zero', () => {
  const data = { items: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id, genres: ['g'] })), profiles: [{ id: 'p', events: [ev('a', 1), ev('b', 2, { kind: 'dislike' }), ev('c', 3), ev('e', 4), ev('f', 5), ev('g', 6)] }] };
  const prep = prepare(data);
  const eng = v2Engine(v2mod);
  eng.fit({ profiles: [] }, prep);
  const list = eng.recommend({ surface: 'home', history: prep.profiles[0].seq, seed: 'c', k: 10, disliked: prep.profiles[0].disliked });
  assert.ok(!list.includes('b'));
  assert.deepEqual(list, ['d']); // neighbours of the profile are unseen titles only; the dislike is out
  const r = evaluate(fixture, { registry, engines: ['v2'], excludeSeen: true });
  assert.equal(r.engines.v2.seenShare, 0);
});

test('v2: the comparison table and the 4.7 gate', async () => {
  const lines = [];
  assert.equal(await main([], { RECO_EVAL_DIST: dist }, (s) => lines.push(s)), 0);
  const out = lines.join('\n');
  assert.match(out, /v2 against the baselines/);
  assert.match(out, /gate \(spec 4\.7\): .*PASS/);
  const gated = [];
  assert.equal(await main(['--gate', '--gate-margin', '50'], { RECO_EVAL_DIST: dist }, (s) => gated.push(s)), 1); // +5000 % is out of reach
  assert.match(gated.join('\n'), /FAIL/);
  assert.equal(await main(['--gate'], { RECO_EVAL_DIST: dist }, () => {}), 0);
  const r = evaluate(fixture, { registry, engines: Object.keys(registry) });
  assert.equal(gate({ engines: { v1: r.engines.v1 } }), null); // no v2, no gate
  assert.equal(gate(r, 0.05).bestName, 'cooccurrence');
  // aggregates only, also with v2
  const json = [];
  await main(['--json'], { RECO_EVAL_DIST: dist }, (s) => json.push(s));
  for (const id of [...fixture.items.map((i) => i.id), ...fixture.profiles.map((p) => p.id)]) assert.ok(!new RegExp(`\\b${id}\\b`).test(out + json.join('\n')), `leaked ${id}`);
});

test('v2: without the compiled backend it is reported, and asking for it explicitly fails', async () => {
  const lines = [], warns = [];
  assert.equal(await main([], { RECO_EVAL_DIST: join(tmpdir(), 'ff-no-such-dist') }, (s) => lines.push(s), (s) => warns.push(s)), 0);
  assert.match(warns.join('\n'), /v2 not evaluated/);
  assert.doesNotMatch(lines.join('\n'), /v2 against/);
  await assert.rejects(main(['--engines', 'v2'], { RECO_EVAL_DIST: join(tmpdir(), 'ff-no-such-dist') }, () => {}), /compiled backend/);
});

// ------------------------------------------------------------------------------------------------------------- ablation (R3)

/** 12 evaluated profiles (+ 8 short ones that only train) that walk the same two chains (a1 -> a2 -> a3 -> a4, b1 -> ... -> b4) on consecutive days after the same filler titles; 40 other titles nobody watched. */
function chainData() {
  // ids of the chains sort after the unwatched titles: when nothing else knows better, ties in the neighbour search favour the unwatched ones
  const chains = ['x-a1', 'x-a2', 'x-a3', 'x-a4', 'x-b1', 'x-b2', 'x-b3', 'x-b4'], filler = ['x-c1', 'x-c2', 'x-c3', 'x-c4'];
  const ids = [...chains, ...filler, ...Array.from({ length: 40 }, (_, i) => `d-${String(i).padStart(2, '0')}`)];
  const items = ids.map((id) => ({ id, genres: [`g-${id}`] }));
  const walk = (p, withFiller) => {
    const chain = chains.slice(p % 2 ? 4 : 0, p % 2 ? 8 : 4);
    return { id: `${withFiller ? 'p' : 'q'}${p}`, events: [...(withFiller ? filler : []).map((x, i) => ({ item: x, ts: 86_400_000 * (i + 1) })), ...chain.map((x, i) => ({ item: x, ts: 86_400_000 * (i + 5) }))] };
  };
  // 12 profiles with 8 titles are evaluated (the last title is held out); 8 short ones (4 titles) are skipped as cases but still train: so the held-out titles are known to others
  return { items, profiles: [...Array.from({ length: 12 }, (_, p) => walk(p, true)), ...Array.from({ length: 8 }, (_, p) => walk(p, false))] };
}

test('ablation: every component is switched off in turn and the table says what moved', () => {
  const abl = ablation(fixture, v2mod, { minProfiles: 5 });
  assert.deepEqual(abl.rows.map((r) => r.component), ABLATION_COMPONENTS);
  assert.equal(abl.meta.evaluatedProfiles, 36);
  near(abl.meta.epsilon, ablationEpsilon(36), 1e-3);
  const by = Object.fromEntries(abl.rows.map((r) => [r.component, r]));
  assert.equal(abl.full.ndcg, evaluate(fixture, { registry, engines: ['v2'] }).engines.v2.ndcg); // "v2 as is" is the v2 column of the main table
  assert.equal(by.affinity.verdict, 'helps'); // without the taste profile the ranking collapses (NDCG@10 -0.2)
  assert.ok(by.affinity.dNdcg < -0.1);
  assert.equal(by.mmr.verdict, 'trade-off'); // re-ranking costs accuracy and buys diversity
  assert.ok(by.mmr.dDiversity < -0.05);
  for (const r of abl.rows) assert.ok(['helps', 'hurts', 'trade-off', 'mixed', 'no effect'].includes(r.verdict));
  assert.deepEqual(abl, ablation(fixture, v2mod, { minProfiles: 5 })); // deterministic
});

test('v2: transitions and co-occurrence of the other profiles predict the next title on sequential data', () => {
  const data = chainData();
  const prep = prepare(data), tr = split(prep, 8);
  const acc = (off) => runEngine(v2Engine(v2mod, { off }), prep, tr).transitionAccuracy;
  assert.equal(acc([]), 1);
  assert.equal(acc(['transition', 'cooccurrence']), 0); // nothing else knows what follows what
  assert.equal(acc(['cooccurrence']), 1); // the transition alone is enough
  const abl = ablation(data, v2mod, { minProfiles: 5, minInteractions: 8 });
  assert.equal(abl.rows.find((r) => r.component === 'transition').component, 'transition');
});

test('ablation: needs enough profiles, prints aggregates only, CLI --ablation', async () => {
  assert.throws(() => ablation(fixture, v2mod, { minProfiles: 1000 }), /need 1000/);
  const lines = [];
  assert.equal(await main(['--ablation'], { RECO_EVAL_DIST: dist }, (x) => lines.push(x)), 0);
  const out = lines.join('\n');
  assert.match(out, /ablation of engine v2/);
  assert.match(out, /not evaluable on a dataset: context features/);
  assert.match(formatAblation(ablation(fixture, v2mod)), /verdict/);
  for (const id of [...fixture.items.map((i) => i.id), ...fixture.profiles.map((p) => p.id)]) assert.ok(!new RegExp(`\\b${id}\\b`).test(out), `leaked ${id}`);
  await assert.rejects(main(['--ablation'], { RECO_EVAL_DIST: join(tmpdir(), 'ff-no-such-dist') }, () => {}), /compiled backend/);
  const json = [];
  await main(['--ablation', '--json'], { RECO_EVAL_DIST: dist }, (x) => json.push(x));
  assert.equal(JSON.parse(json[0]).rows.length, ABLATION_COMPONENTS.length);
});

// ----------------------------------------------------------------------------------------------------- IPW replay (R3b)

test('IPW replay: the logging policy is valued exactly without exploration and without bias with it', () => {
  const none = ipwReplay(fixture, v2mod, { explore: 0, rounds: 3, minProfiles: 5 });
  const v2row = (r) => r.rows.find((x) => x.policy === 'v2');
  assert.equal(v2row(none).ipw, v2row(none).direct); // propensity 1 everywhere: the log is the policy
  assert.equal(v2row(none).support, 1);
  assert.equal(v2row(none).direct, evaluate(fixture, { registry, engines: ['v2'] }).engines.v2.ndcg);
  const some = ipwReplay(fixture, v2mod, { explore: 0.3, rounds: 1500, seed: 7, minProfiles: 5 });
  assert.deepEqual(some.rows.map((r) => r.policy), ['v2', 'v2 without cooccurrence', 'v2 without affinity', 'popularity', 'cooccurrence']);
  for (const r of some.rows) {
    if (r.matches) near(r.ipw, r.supported, 0.03); // unbiased for the supported part of the target's slots
    assert.ok(r.supported <= r.direct + 1e-9 && r.support <= 1);
  }
  near(v2row(some).ipw, v2row(some).direct, 0.02);
  assert.ok(some.rows.find((r) => r.policy === 'popularity').support < 0.5, 'a policy far from v2 is mostly out of support');
  assert.ok(some.rows.find((r) => r.policy === 'v2 without cooccurrence').effectiveSample > 0);
  assert.deepEqual(some, ipwReplay(fixture, v2mod, { explore: 0.3, rounds: 1500, seed: 7, minProfiles: 5 })); // seeded: reproducible
  assert.notDeepEqual(some.rows[1], ipwReplay(fixture, v2mod, { explore: 0.3, rounds: 1500, seed: 8, minProfiles: 5 }).rows[1]);
  assert.throws(() => ipwReplay(fixture, v2mod, { minProfiles: 1000 }), /need 1000/);
});

test('IPW replay: CLI, aggregates only', async () => {
  const lines = [];
  assert.equal(await main(['--ipw', '--rounds', '20', '--explore', '0.2'], { RECO_EVAL_DIST: dist }, (x) => lines.push(x)), 0);
  const out = lines.join('\n');
  assert.match(out, /inverse-propensity-weighted replay/);
  assert.match(out, /exploration 0\.2/);
  assert.match(formatIpw(ipwReplay(fixture, v2mod, { rounds: 5, minProfiles: 5 })), /support/);
  for (const id of [...fixture.items.map((i) => i.id), ...fixture.profiles.map((p) => p.id)]) assert.ok(!new RegExp(`\\b${id}\\b`).test(out), `leaked ${id}`);
  await assert.rejects(main(['--ipw'], { RECO_EVAL_DIST: join(tmpdir(), 'ff-no-such-dist') }, () => {}), /compiled backend/);
});
