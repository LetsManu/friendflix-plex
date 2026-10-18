#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Offline evaluation of recommendation engines (spec 4.7, step R0): leave-last-out per profile.
 *
 *   node scripts/reco-eval.mjs                         # the bundled fixture (scripts/fixtures/reco-eval.json)
 *   node scripts/reco-eval.mjs --data my.json --json   # a dataset file (format below)
 *   DATABASE_URL=postgres://... node scripts/reco-eval.mjs --db [--items items.json] [--similar similar.json]
 *
 * For every profile with at least 10 interactions the last one is held out; every engine sees the earlier ones and recommends.
 * Printed are aggregates only (never an item, a title or a profile). The DB is read in one READ ONLY transaction.
 *
 * Dataset: { items: [{ id, genres?: string[], year?: number }],
 *            profiles: [{ id, kids?: boolean, events: [{ item, ts, kind?: 'play' | 'like' | 'dislike' }] }],
 *            similar?: { [seedItemId]: string[] }   // recorded Jellyfin similar() answers, best first (optional)
 *          }
 * Engines implement { name, fit(train), recommend({ surface: 'home' | 'next', history, seed, k }) -> itemIds }: see ENGINES.
 *
 * Engine v2 (R2) is the real code of backend/src/reco (taste maths, item vectors, scoring, MMR) in its offline form, backend/src/reco/offline.ts.
 * The script imports the compiled backend, so build it first:   npm run build -w backend
 * (RECO_EVAL_DIST points at another compiled directory.) Without the build v2 is reported as not evaluated; asking for it with --engines fails.
 * Item features beyond genres and year are optional in the dataset: tags, studios, people (arrays), runtime (min), rating (0-10), collection, added (ms).
 * The run prints a v2-versus-baselines comparison and the spec 4.7 gate (v2 NDCG@10 must beat every baseline by --gate-margin, default 5 %);
 * --gate makes a failed gate exit with code 1.
 *
 * R3: v2 also uses co-occurrence, transitions and trending built from the dataset's other profiles (minimum support of 2 profiles, as live).
 * R3b: `--ipw` replays a logged exploration policy (v2 with RECO_EXPLORE-style exploration, seeded) and values other rankings from the log by
 * inverse propensity weighting, next to their true value. `--ablation` prints one table: v2 with each score component switched off in turn, and what that does to NDCG@10 (home), HitRate@10 and
 * transition accuracy (post-play). Context features, the friends signal and fresh labels need data a dataset does not have (time of day,
 * device, friends, library dates) and are reported as not evaluable.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { Console } from 'node:console';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const K = 10; // list length the metrics look at
export const DEPTH = 50; // engines return up to this many ids; MRR looks this deep
export const MIN_INTERACTIONS = 10;
export const MIN_SUPPORT = 2; // spec 4.8: cross-user signals only as aggregates of >= 2 profiles
export const DEFAULT_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reco-eval.json');
/** popularity tiers by train rank: head = top 20 % of the catalog, tail = bottom 50 %, mid = the 30 % in between */
export const HEAD_SHARE = 0.2;
export const TAIL_SHARE = 0.5;

// ---------------------------------------------------------------------------------------------------------------- dataset

/** Positive interactions per profile, oldest first, one entry per item (first occurrence; `liked` if ever liked); dislikes kept apart. */
export function prepare(data) {
  const profiles = [];
  for (const p of data.profiles ?? []) {
    const first = new Map();
    const disliked = new Set();
    const events = [...(p.events ?? [])].map((e) => ({ ...e, t: typeof e.ts === 'number' ? e.ts : Date.parse(e.ts) })).sort((a, b) => a.t - b.t || (a.item < b.item ? -1 : 1));
    for (const e of events) {
      if (e.kind === 'dislike') { disliked.add(e.item); continue; }
      const cur = first.get(e.item);
      if (!cur) first.set(e.item, { item: e.item, t: e.t, liked: e.kind === 'like', likedAt: e.kind === 'like' ? e.t : -Infinity });
      else if (e.kind === 'like') { cur.liked = true; cur.likedAt = e.t; }
    }
    profiles.push({ id: p.id, kids: Boolean(p.kids), seq: [...first.values()], disliked });
  }
  const features = new Map((data.items ?? []).map((i) => [i.id, i]));
  const catalog = new Set(features.keys());
  for (const p of profiles) for (const e of p.seq) catalog.add(e.item);
  return { profiles, features, catalog, similar: data.similar ?? {} };
}

/** Train data: every kids profile is left out (they never feed cross-user signals), held-out items are removed from the profile's sequence. */
export function split(prep, minInteractions = MIN_INTERACTIONS) {
  const train = []; // all non-kids profiles, minus the held-out item where there is one
  const cases = [];
  let skipped = 0;
  for (const p of prep.profiles) {
    if (p.kids) continue;
    if (p.seq.length < minInteractions) { skipped++; train.push({ id: p.id, seq: p.seq, disliked: p.disliked }); continue; }
    const target = p.seq[p.seq.length - 1];
    const seq = p.seq.slice(0, -1);
    train.push({ id: p.id, seq, disliked: p.disliked });
    cases.push({ id: p.id, history: seq, target: target.item, disliked: p.disliked });
  }
  return { train, cases, skipped };
}

// --------------------------------------------------------------------------------------------------------------- engines

const byScoreThenId = (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const top = (scores, n = DEPTH) => [...scores.entries()].sort(byScoreThenId).slice(0, n).map(([id]) => id);

/** Number of distinct profiles per item. */
export function popularityCounts(train) {
  const n = new Map();
  for (const p of train) for (const e of p.seq) n.set(e.item, (n.get(e.item) ?? 0) + 1);
  return n;
}

/** Popularity only: the items most profiles watched, minus what the profile has seen. Ignores the seed. */
export function popularityEngine() {
  let pop = new Map();
  return {
    name: 'popularity',
    fit(train) { pop = popularityCounts(train.profiles); },
    recommend({ history }) {
      const seen = new Set(history.map((e) => e.item));
      const s = new Map();
      for (const [id, n] of pop) if (!seen.has(id) && n >= MIN_SUPPORT) s.set(id, n);
      return top(s);
    },
  };
}

/**
 * v1: what libraryBecause does. Seed = the profile's latest like, else the last finished title; candidates = the media server's
 * similar() for the seed, in its order, minus thumbs-down. Played titles are NOT filtered (v1 does not either).
 * Offline there is no media server: similar() comes from the dataset's recorded `similar` map and, for seeds that are not in it,
 * from an emulation over the item features (genre overlap, then closeness in year), 30 items like the real call.
 */
export function v1Engine() {
  let prep;
  const emulate = (seed) => {
    const f = prep.features.get(seed);
    if (!f) return [];
    const g = new Set(f.genres ?? []);
    const s = new Map();
    for (const [id, o] of prep.features) {
      if (id === seed) continue;
      const og = o.genres ?? [];
      const inter = og.filter((x) => g.has(x)).length;
      if (!inter) continue;
      const jac = inter / (g.size + og.length - inter);
      const near = f.year && o.year ? 1 - Math.min(Math.abs(f.year - o.year), 20) / 20 : 0;
      s.set(id, jac + 0.1 * near);
    }
    return top(s, 30);
  };
  return {
    name: 'v1',
    fit(_train, p) { prep = p; },
    recommend({ history, disliked }) {
      if (!history.length) return [];
      const liked = history.filter((e) => e.liked).sort((a, b) => b.likedAt - a.likedAt)[0];
      const seed = (liked ?? history[history.length - 1]).item;
      const sim = prep.similar[seed] ?? emulate(seed);
      return sim.filter((id) => id !== seed && !disliked?.has(id)).slice(0, DEPTH);
    },
  };
}

/**
 * Item-item co-occurrence: cosine over "watched by the same profile" (pairs seen in >= minSupport profiles only).
 * surface 'home': the profile's whole history, newer titles weigh more (0.85 per step back).
 * surface 'next': titles that directly followed the seed in other profiles, then co-occurrence with the seed as the filler.
 */
export function cooccurrenceEngine({ minSupport = MIN_SUPPORT, decay = 0.85 } = {}) {
  let pop = new Map();
  const pair = new Map(); // item -> Map(other -> profiles)
  const next = new Map(); // item -> Map(following item -> profiles)
  const bump = (m, a, b) => { let r = m.get(a); if (!r) m.set(a, (r = new Map())); r.set(b, (r.get(b) ?? 0) + 1); };
  const cos = (a, b) => (pair.get(a)?.get(b) ?? 0) / Math.sqrt((pop.get(a) ?? 1) * (pop.get(b) ?? 1));
  return {
    name: 'cooccurrence',
    fit(train) {
      pop = popularityCounts(train.profiles);
      for (const p of train.profiles) {
        const ids = [...new Set(p.seq.map((e) => e.item))];
        for (const a of ids) for (const b of ids) if (a !== b) bump(pair, a, b);
        const seen = new Set();
        for (let i = 0; i + 1 < p.seq.length; i++) {
          const k = p.seq[i].item + '>' + p.seq[i + 1].item;
          if (!seen.has(k)) { seen.add(k); bump(next, p.seq[i].item, p.seq[i + 1].item); }
        }
      }
    },
    recommend({ surface, history, seed }) {
      const seen = new Set(history.map((e) => e.item));
      const s = new Map();
      const add = (id, v) => { if (!seen.has(id)) s.set(id, (s.get(id) ?? 0) + v); };
      if (surface === 'next' && seed) {
        for (const [id, n] of next.get(seed) ?? []) if (n >= minSupport) add(id, 1 + n);
        for (const [id, n] of pair.get(seed) ?? []) if (n >= minSupport) add(id, cos(seed, id));
      } else {
        history.forEach((e, i) => {
          const w = decay ** (history.length - 1 - i);
          for (const [id, n] of pair.get(e.item) ?? []) if (n >= minSupport) add(id, w * cos(e.item, id));
        });
      }
      return top(s);
    },
  };
}

/** Name -> factory of the engines that need nothing built. v2 is added by main() when the compiled backend is there (loadV2), more through --plugin. */
export const ENGINES = { popularity: popularityEngine, v1: v1Engine, cooccurrence: cooccurrenceEngine };

export const DEFAULT_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'dist');
/** The compiled offline v2 module (backend/dist/reco/offline.js), or null when the backend is not built. */
export async function loadV2(dist = DEFAULT_DIST) {
  try {
    const mod = await import(pathToFileURL(join(dist, 'reco', 'offline.js')).href);
    return typeof mod.offlineEngine === 'function' ? mod : null;
  } catch {
    return null;
  }
}

/**
 * v2: backend/src/reco in its offline form. The dataset's items are the index (IDF over the dataset); similar() answers come from the
 * recorded `similar` map (without one the seed's nearest neighbours stand in). 'home' = profile taste (surface home_rows, no seed),
 * 'next' = post-play (surface postplay, seed = the last title).
 */
export function v2Engine(mod, { off = [] } = {}) {
  let eng;
  return {
    name: 'v2',
    fit(train, prep) {
      const items = new Map([...prep.catalog].map((id) => [id, { id }]));
      for (const [id, f] of prep.features) items.set(id, f);
      // the other profiles feed co-occurrence, transitions and trending (the sequences carry the event times)
      eng = mod.offlineEngine([...items.values()], prep.similar, undefined, { train: train?.profiles ?? [], off });
    },
    recommend({ surface, history, seed, k, disliked }) {
      return eng.recommend({ surface, history, ...(seed ? { seed } : {}), k, disliked });
    },
    /** the ranked list and the scored pool (for exploration), R3b */
    slate({ surface, history, seed, k, disliked }) {
      return eng.slate({ surface, history, ...(seed ? { seed } : {}), k, disliked });
    },
  };
}

/** Spec 4.7 gate: v2 NDCG@10 beats every other engine by `margin` (relative). null when v2 or a baseline is missing. */
export function gate(res, margin = 0.05) {
  const v2 = res.engines.v2;
  const others = Object.entries(res.engines).filter(([n]) => n !== 'v2');
  if (!v2 || !others.length) return null;
  const [bestName, best] = others.reduce((a, b) => (b[1].ndcg > a[1].ndcg ? b : a));
  return { pass: v2.ndcg > best.ndcg * (1 + margin), margin, v2: v2.ndcg, best: best.ndcg, bestName };
}

/** The score components of the offline v2 that the ablation switches off one at a time (backend/src/reco/offline.ts OFFLINE_COMPONENTS). */
export const ABLATION_COMPONENTS = ['affinity', 'seed', 'cooccurrence', 'transition', 'quality', 'fresh', 'trending', 'mmr'];
/** Not evaluable on a dataset: they need data it does not have. */
export const NOT_EVALUABLE = ['context features (time of day, device, language, runtime budget, series status)', 'friends signal', 'fresh labels of the media server'];
/** The smallest change the table can resolve: one evaluated profile moving a hit in or out of the top 10 changes NDCG@10 by about 1 / profiles. */
export const ablationEpsilon = (profiles) => (profiles > 0 ? 1 / profiles : 1);

/**
 * Ablation: v2 as is, and v2 with each component left out. `d*` = left-out minus full, so a negative NDCG delta means the component helps.
 * verdict: "helps" (NDCG@10 or transition accuracy drops by more than one profile's worth without it), "hurts" (rises), "trade-off" (rises,
 * but the diversity of the lists falls by more than 0.05: the component buys diversity with accuracy), else "no effect".
 */
export function ablation(data, mod, { minInteractions = MIN_INTERACTIONS, minProfiles = 1, excludeSeen = false } = {}) {
  const prep = prepare(data);
  const tr = split(prep, minInteractions);
  if (tr.cases.length < minProfiles) throw new Error(`only ${tr.cases.length} profile(s) with >= ${minInteractions} interactions; need ${minProfiles} for aggregates`);
  const full = runEngine(v2Engine(mod), prep, tr, { excludeSeen });
  const eps = ablationEpsilon(tr.cases.length);
  const rows = ABLATION_COMPONENTS.map((component) => {
    const m = runEngine(v2Engine(mod, { off: [component] }), prep, tr, { excludeSeen });
    const dNdcg = round(m.ndcg - full.ndcg), dTrans = round(m.transitionAccuracy - full.transitionAccuracy), dDiversity = round(m.diversity - full.diversity);
    const helps = dNdcg < -eps || dTrans < -eps, hurts = dNdcg > eps || dTrans > eps;
    const verdict = helps && !hurts ? 'helps' : hurts && !helps ? (dDiversity < -0.05 ? 'trade-off' : 'hurts') : helps && hurts ? 'mixed' : 'no effect';
    return { component, ndcg: m.ndcg, hitRate: m.hitRate, transitionAccuracy: m.transitionAccuracy, diversity: m.diversity, dNdcg, dHitRate: round(m.hitRate - full.hitRate), dTrans, dDiversity, verdict };
  });
  return { meta: { k: K, evaluatedProfiles: tr.cases.length, epsilon: round(eps), notEvaluable: NOT_EVALUABLE }, full: { ndcg: full.ndcg, hitRate: full.hitRate, transitionAccuracy: full.transitionAccuracy, diversity: full.diversity }, rows };
}

export const IPW_DEFAULTS = { explore: 0.1, rounds: 200, seed: 1 };

/**
 * Inverse-propensity-weighted replay (spec 4.5, 4.7; R3b). The logging policy is engine v2 with exploration at rate `explore`: every case's
 * slate is v2's top 10 with about one eligible slot in ten (the best 3 are never touched) replaced by a medium-score candidate, repeated
 * for `rounds` rounds with a seeded generator. Each logged slot carries its propensity: 1 - explore for the ranked title, explore / band
 * size for an explored one, 1 for the protected top. A target policy (any ranking) is then valued from the log alone:
 *     value = mean over cases and rounds of  sum over slots j of  discount(j) * [logged_j = target_j = held-out title] / propensity_j
 * (discount(j) = 1 / log2(j + 2), so this is NDCG@10), and compared with its true value on the same cases. The estimate is unbiased for
 * every slot whose target title had a chance of being logged ("support"); the share of such slots is reported, because a target that wants
 * titles the logging policy never shows cannot be valued from the log at all. With `explore` 0 only the logging policy itself is valued.
 * Targets: v2 itself, v2 without co-occurrence / without taste affinity, popularity, co-occurrence.
 */
export function ipwReplay(data, mod, { explore = IPW_DEFAULTS.explore, rounds = IPW_DEFAULTS.rounds, seed = IPW_DEFAULTS.seed, minInteractions = MIN_INTERACTIONS, minProfiles = 1 } = {}) {
  const prep = prepare(data);
  const tr = split(prep, minInteractions);
  if (tr.cases.length < minProfiles) throw new Error(`only ${tr.cases.length} profile(s) with >= ${minInteractions} interactions; need ${minProfiles} for aggregates`);
  const logger = v2Engine(mod);
  logger.fit({ profiles: tr.train }, prep);
  const policies = {
    v2: logger, 'v2 without cooccurrence': v2Engine(mod, { off: ['cooccurrence'] }), 'v2 without affinity': v2Engine(mod, { off: ['affinity'] }),
    popularity: ENGINES.popularity(), cooccurrence: ENGINES.cooccurrence(),
  };
  for (const e of Object.values(policies)) if (e !== logger) e.fit({ profiles: tr.train }, prep);
  const q = (c) => ({ surface: 'home', history: c.history, seed: c.history[c.history.length - 1]?.item, k: K, disliked: c.disliked });
  const disc = (j) => 1 / Math.log2(j + 2);
  const rng = mod.seededRng(seed);
  // the logs: per case, `rounds` slates with their propensities
  const logs = tr.cases.map((c) => {
    const s = logger.slate(q(c));
    return Array.from({ length: rounds }, () => mod.exploreSlate(s.ranked, s.pool, explore, rng));
  });
  const out = [];
  for (const [name, eng] of Object.entries(policies)) {
    let truth = 0, truthSupported = 0, est = 0, slots = 0, supported = 0, matches = 0, sumW = 0, sumW2 = 0;
    tr.cases.forEach((c, n) => {
      const target = eng.recommend(q(c)).slice(0, K);
      const at = target.indexOf(c.target);
      if (at >= 0) truth += disc(at);
      const seen = target.map(() => false);
      for (const l of logs[n]) {
        target.forEach((id, j) => {
          if (l.ids[j] === id) seen[j] = true;
          if (j === at && l.ids[j] === id) {
            const w = 1 / l.propensity[j];
            est += disc(j) * w; matches++; sumW += w; sumW2 += w * w;
          }
        });
      }
      if (at >= 0 && seen[at]) truthSupported += disc(at);
      slots += target.length;
      supported += seen.filter(Boolean).length;
    });
    const cases = tr.cases.length;
    out.push({
      policy: name, direct: round(truth / cases), supported: round(truthSupported / cases), ipw: round(est / (cases * rounds)), support: round(slots ? supported / slots : null),
      matches, effectiveSample: round(sumW2 ? (sumW * sumW) / sumW2 : 0, 1),
    });
  }
  return { meta: { k: K, evaluatedProfiles: tr.cases.length, explore, rounds, seed }, rows: out };
}

export function formatIpw(res) {
  const lines = [`inverse-propensity-weighted replay of the v2 logging policy with exploration ${res.meta.explore} (profiles: ${res.meta.evaluatedProfiles}, rounds: ${res.meta.rounds}, seed: ${res.meta.seed}, k=${res.meta.k})`, ''];
  lines.push('target policy'.padEnd(26) + ['true NDCG@10', 'true, supported', 'IPW estimate', 'error', 'support', 'matches', 'eff. n'].map((h) => h.padStart(17)).join(''));
  for (const r of res.rows) {
    const err = r.ipw === null || r.supported === null ? null : r.ipw - r.supported;
    lines.push(r.policy.padEnd(26) + [num(r.direct), num(r.supported), num(r.ipw), err === null ? '   n/a' : (err > 0 ? '+' : '') + err.toFixed(3), pct(r.support), String(r.matches), String(r.effectiveSample)].map((h) => h.padStart(17)).join(''));
  }
  lines.push('', 'support = share of the target slots whose title the logging policy showed there at least once. "true, supported" = the true value counting only supported slots;',
    'the IPW estimate is unbiased for that (error = IPW minus it). Titles the log never showed cannot be valued, so for a target that differs from v2 the estimate is a lower bound of the true value.',
    'A target is valued from the explored slots that happen to match: noisy (see eff. n).');
  return lines.join('\n');
}

// -------------------------------------------------------------------------------------------------------------- metrics

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const round = (x, d = 4) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** 1 - Jaccard of the genre sets, averaged over all pairs of the list; null without genres. */
export function listDiversity(ids, features) {
  const sets = ids.map((id) => new Set(features.get(id)?.genres ?? [])).filter((s) => s.size);
  if (sets.length < 2) return null;
  const d = [];
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) {
    const inter = [...sets[i]].filter((x) => sets[j].has(x)).length;
    d.push(1 - inter / (sets[i].size + sets[j].size - inter));
  }
  return mean(d);
}

/** Tier of every catalog item by train popularity: 'head' | 'mid' | 'tail' (ties by id; unseen items are tail). */
export function popularityTiers(catalog, pop) {
  const ranked = [...catalog].sort((a, b) => (pop.get(b) ?? 0) - (pop.get(a) ?? 0) || (a < b ? -1 : 1));
  const head = Math.ceil(ranked.length * HEAD_SHARE), tailFrom = Math.floor(ranked.length * (1 - TAIL_SHARE));
  return new Map(ranked.map((id, i) => [id, i < head ? 'head' : i >= tailFrom ? 'tail' : 'mid']));
}

/** Runs one engine over the cases and returns the aggregate metrics. */
export function runEngine(engine, prep, tr, { excludeSeen = false } = {}) {
  const pop = popularityCounts(tr.train);
  const tiers = popularityTiers(prep.catalog, pop);
  engine.fit({ profiles: tr.train }, prep);
  const finish = (ids, c) => {
    const seen = new Set(c.history.map((e) => e.item));
    return (excludeSeen ? ids.filter((id) => !seen.has(id)) : ids).slice(0, DEPTH);
  };
  const m = { hit: [], ndcg: [], rr: [], trans: [], div: [], recs: 0, seenRecs: 0, hitTiers: [], cold: [], covered: new Set() };
  for (const c of tr.cases) {
    const seed = c.history[c.history.length - 1]?.item;
    const list = finish(engine.recommend({ surface: 'home', history: c.history, seed, k: DEPTH, disliked: c.disliked }), c);
    const rank = list.indexOf(c.target) + 1 || null; // 1-based
    const hit = rank !== null && rank <= K;
    m.hit.push(hit ? 1 : 0);
    m.ndcg.push(hit ? 1 / Math.log2(rank + 1) : 0);
    m.rr.push(rank ? 1 / rank : 0);
    const topK = list.slice(0, K);
    const seen = new Set(c.history.map((e) => e.item));
    m.recs += topK.length;
    m.seenRecs += topK.filter((id) => seen.has(id)).length;
    for (const id of topK) if (prep.catalog.has(id)) m.covered.add(id);
    const d = listDiversity(topK, prep.features);
    if (d !== null) m.div.push(d);
    if (hit) m.hitTiers.push(tiers.get(c.target) ?? 'tail');
    if (!pop.get(c.target)) m.cold.push(hit ? 1 : 0);
    const nxt = finish(engine.recommend({ surface: 'next', history: c.history, seed, k: DEPTH, disliked: c.disliked }), c);
    m.trans.push(nxt.slice(0, K).includes(c.target) ? 1 : 0);
  }
  const hits = m.hitTiers.length;
  return {
    hitRate: round(mean(m.hit)),
    ndcg: round(mean(m.ndcg)),
    mrr: round(mean(m.rr)),
    coverage: round(prep.catalog.size ? m.covered.size / prep.catalog.size : null),
    diversity: round(mean(m.div)),
    seenShare: round(m.recs ? m.seenRecs / m.recs : null),
    midPopularityShare: round(hits ? m.hitTiers.filter((t) => t === 'mid').length / hits : null),
    newTitleHitRate: round(mean(m.cold)),
    transitionAccuracy: round(mean(m.trans)),
    hits,
    coldCases: m.cold.length,
  };
}

/** The whole evaluation: { meta, engines: { name: metrics } }. Throws when fewer than minProfiles profiles qualify (an aggregate of one person is not one). */
export function evaluate(data, { engines = Object.keys(ENGINES), registry = ENGINES, minInteractions = MIN_INTERACTIONS, minProfiles = 1, excludeSeen = false } = {}) {
  const prep = prepare(data);
  const tr = split(prep, minInteractions);
  if (tr.cases.length < minProfiles) throw new Error(`only ${tr.cases.length} profile(s) with >= ${minInteractions} interactions; need ${minProfiles} for aggregates`);
  const out = {};
  for (const name of engines) {
    const make = registry[name];
    if (!make) throw new Error(`unknown engine "${name}" (known: ${Object.keys(registry).join(', ')})`);
    out[name] = runEngine(make(), prep, tr, { excludeSeen });
  }
  return { meta: { k: K, depth: DEPTH, evaluatedProfiles: tr.cases.length, skippedProfiles: tr.skipped, catalogSize: prep.catalog.size, excludeSeen }, engines: out };
}

// ------------------------------------------------------------------------------------------------------------------ I/O

/**
 * Reads interactions from the database in one READ ONLY transaction (nothing is written, the connection string is never printed).
 * Positive events: play_seconds rows with >= minSeconds in total (user level: attributed to the owner profile, whose id is the
 * user id; day resolution), thumbs up/loved and ratings >= 4 stars (profile level). Thumbs down become dislikes.
 * Item features and similar() are not in the database: pass them with --items / --similar (otherwise diversity is empty and v1
 * has nothing to recommend from).
 */
export async function loadFromDb(connectionString, { minSeconds = 120 } = {}) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString, max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const profiles = new Map();
    const get = (id) => { let p = profiles.get(id); if (!p) profiles.set(id, (p = { id, kids: false, events: [] })); return p; };
    for (const r of (await c.query('select id, kids from profiles')).rows) get(r.id).kids = r.kids;
    const plays = await c.query(`select user_id as pid, item_id, min(day)::text as ts from play_seconds group by user_id, item_id having sum(seconds) >= $1`, [minSeconds]);
    for (const r of plays.rows) if (profiles.has(r.pid)) get(r.pid).events.push({ item: r.item_id, ts: r.ts });
    for (const r of (await c.query('select profile_id as pid, item_id, value, created_at as ts from thumbs')).rows) {
      if (profiles.has(r.pid)) get(r.pid).events.push({ item: r.item_id, ts: r.ts.toISOString(), kind: r.value < 0 ? 'dislike' : 'like' });
    }
    for (const r of (await c.query('select user_id as pid, item_id, created_at as ts from ratings where stars >= 4')).rows) {
      if (profiles.has(r.pid)) get(r.pid).events.push({ item: r.item_id, ts: r.ts.toISOString() });
    }
    await c.query('ROLLBACK');
    return { items: [], profiles: [...profiles.values()] };
  } finally {
    c.release();
    await pool.end();
  }
}

const pct = (x) => (x === null ? '   n/a' : (x * 100).toFixed(1).padStart(5) + '%');
const num = (x) => (x === null ? '   n/a' : x.toFixed(3).padStart(6));

export function format(res) {
  const rows = [
    ['HitRate@10', 'hitRate', pct], ['NDCG@10', 'ndcg', num], ['MRR', 'mrr', num], ['Coverage', 'coverage', pct], ['Diversity (ILD)', 'diversity', num],
    ['Already seen', 'seenShare', pct], ['Mid-pop. share of hits', 'midPopularityShare', pct], ['New-title hit rate', 'newTitleHitRate', pct], ['Transition accuracy', 'transitionAccuracy', pct],
  ];
  const names = Object.keys(res.engines);
  const lines = [`profiles evaluated: ${res.meta.evaluatedProfiles} (skipped, < ${MIN_INTERACTIONS} interactions: ${res.meta.skippedProfiles}), catalog: ${res.meta.catalogSize}, k=${res.meta.k}${res.meta.excludeSeen ? ', seen titles removed' : ''}`, ''];
  lines.push('metric'.padEnd(24) + names.map((n) => n.padStart(14)).join(''));
  for (const [label, key, f] of rows) lines.push(label.padEnd(24) + names.map((n) => f(res.engines[n][key]).padStart(14)).join(''));
  lines.push('cold-start cases'.padEnd(24) + names.map((n) => String(res.engines[n].coldCases).padStart(14)).join(''));
  const v2 = res.engines.v2;
  const base = names.filter((n) => n !== 'v2');
  if (v2 && base.length) {
    lines.push('', 'v2 against the baselines (percentage points; for "Already seen" lower is better)');
    lines.push('metric'.padEnd(24) + base.map((n) => n.padStart(14)).join(''));
    for (const [label, key] of rows) {
      const seen = key === 'seenShare';
      lines.push(label.padEnd(24) + base.map((n) => {
        const a = v2[key], b = res.engines[n][key];
        if (a === null || b === null) return '   n/a'.padStart(14);
        const d = (a - b) * (['hitRate', 'coverage', 'seenShare', 'midPopularityShare', 'newTitleHitRate', 'transitionAccuracy'].includes(key) ? 100 : 1);
        const unit = key === 'ndcg' || key === 'mrr' || key === 'diversity' ? '' : ' pp';
        return ((d > 0 ? '+' : '') + d.toFixed(unit ? 1 : 3) + unit + (seen ? (d < 0 ? ' *' : '') : d > 0 ? ' *' : '')).padStart(14);
      }).join(''));
    }
    lines.push('(* = v2 is better)');
    const g = gate(res, res.meta.gateMargin);
    if (g) lines.push(`gate (spec 4.7): v2 NDCG@10 ${g.v2.toFixed(3)} vs best baseline ${g.bestName} ${g.best.toFixed(3)}, needs +${(g.margin * 100).toFixed(0)} %: ${g.pass ? 'PASS' : 'FAIL'}`);
  }
  return lines.join('\n');
}

/** The ablation table as text. */
export function formatAblation(res) {
  const d4 = (x) => (x === null ? '   n/a' : ((x > 0 ? '+' : '') + x.toFixed(3)).padStart(6));
  const lines = [`ablation of engine v2: each component switched off in turn (profiles evaluated: ${res.meta.evaluatedProfiles}, k=${res.meta.k})`, ''];
  lines.push('left out'.padEnd(16) + ['NDCG@10', 'd NDCG', 'HitRate@10', 'd Hit', 'Transition', 'd Trans', 'Diversity', 'd Div'].map((h) => h.padStart(11)).join('') + '  verdict');
  lines.push('(v2 as is)'.padEnd(16) + [num(res.full.ndcg), '', pct(res.full.hitRate), '', pct(res.full.transitionAccuracy), '', num(res.full.diversity), ''].map((h) => h.padStart(11)).join(''));
  for (const r of res.rows) {
    lines.push(r.component.padEnd(16) + [num(r.ndcg), d4(r.dNdcg), pct(r.hitRate), d4(r.dHitRate), pct(r.transitionAccuracy), d4(r.dTrans), num(r.diversity), d4(r.dDiversity)].map((h) => h.padStart(11)).join('') + '  ' + r.verdict);
  }
  lines.push('', `verdict: "helps" = NDCG@10 or transition accuracy falls by more than ${res.meta.epsilon} (one profile's worth) without the component, "hurts" = it rises,`,
    '"trade-off" = it rises but the lists lose diversity (the component buys diversity), "mixed" = one up, one down, else "no effect"');
  lines.push('not evaluable on a dataset: ' + res.meta.notEvaluable.join('; '));
  return lines.join('\n');
}

export function parseArgs(argv) {
  const o = { engines: undefined, minProfiles: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], val = () => argv[++i];
    if (a === '--db') o.db = true;
    else if (a === '--json') o.json = true;
    else if (a === '--exclude-seen') o.excludeSeen = true;
    else if (a === '--ablation') o.ablation = true;
    else if (a === '--ipw') o.ipw = true;
    else if (a === '--explore') o.explore = Number(val());
    else if (a === '--rounds') o.rounds = Number(val());
    else if (a === '--seed') o.seed = Number(val());
    else if (a === '--data') o.data = val();
    else if (a === '--items') o.items = val();
    else if (a === '--similar') o.similar = val();
    else if (a === '--plugin') o.plugin = val();
    else if (a === '--engines') o.engines = val().split(',').filter(Boolean);
    else if (a === '--min-profiles') o.minProfiles = Number(val());
    else if (a === '--min-seconds') o.minSeconds = Number(val());
    else if (a === '--gate') o.gate = true;
    else if (a === '--gate-margin') o.gateMargin = Number(val());
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const HELP = `usage: node scripts/reco-eval.mjs [--data file.json | --db] [--engines popularity,v1,cooccurrence,v2] [--exclude-seen] [--json] [--ablation] [--ipw] [--ipw]
  (v2 needs the compiled backend: npm run build -w backend; RECO_EVAL_DIST = another build directory)
  --ablation        v2 with each score component left out in turn: which ones move NDCG@10 (needs the compiled backend)
  --ipw             inverse-propensity-weighted replay of v2 with exploration (--explore 0.1, --rounds 200, --seed 1); needs the compiled backend
  --gate            exit 1 when v2 does not beat every baseline on NDCG@10 by the margin (spec 4.7 gate)
  --gate-margin X   relative margin of the gate (default 0.05 = 5 %)
  --db              read interactions from DATABASE_URL (read only); --items / --similar add features and recorded similar() answers
  --min-profiles N  refuse to print fewer than N evaluated profiles (default 5)
  --plugin file.mjs add engines (module exports { engines: { name: factory } })`;

const out = new Console(process.stdout, process.stderr);

export async function main(argv, env = process.env, log = (s) => out.log(s), warn = (s) => out.error(s)) {
  const o = parseArgs(argv);
  if (o.help) { log(HELP); return 0; }
  let data;
  if (o.db) {
    if (!env.DATABASE_URL) throw new Error('--db needs DATABASE_URL');
    data = await loadFromDb(env.DATABASE_URL, { minSeconds: o.minSeconds });
    if (o.items) data.items = JSON.parse(readFileSync(o.items, 'utf8'));
    if (o.similar) data.similar = JSON.parse(readFileSync(o.similar, 'utf8'));
  } else {
    data = JSON.parse(readFileSync(o.data ?? DEFAULT_FIXTURE, 'utf8'));
  }
  let registry = ENGINES;
  const v2 = await loadV2(env.RECO_EVAL_DIST || DEFAULT_DIST);
  if (v2) registry = { ...registry, v2: () => v2Engine(v2) };
  if (o.plugin) registry = { ...registry, ...(await import(pathToFileURL(o.plugin).href)).engines };
  if (!v2 && o.engines?.includes('v2') && !registry.v2) throw new Error('engine v2 needs the compiled backend: run `npm run build -w backend` (or set RECO_EVAL_DIST)');
  if (!v2 && !o.engines && !registry.v2) warn('reco-eval: v2 not evaluated, the backend is not built (npm run build -w backend)');
  if (o.ipw) {
    if (!v2) throw new Error('--ipw needs the compiled backend: run `npm run build -w backend` (or set RECO_EVAL_DIST)');
    const rep = ipwReplay(data, v2, { ...(Number.isFinite(o.explore) ? { explore: o.explore } : {}), ...(Number.isFinite(o.rounds) ? { rounds: o.rounds } : {}), ...(Number.isFinite(o.seed) ? { seed: o.seed } : {}), minProfiles: o.minProfiles ?? 5 });
    log(o.json ? JSON.stringify(rep, null, 2) : formatIpw(rep));
    return 0;
  }
  if (o.ablation) {
    if (!v2) throw new Error('--ablation needs the compiled backend: run `npm run build -w backend` (or set RECO_EVAL_DIST)');
    const abl = ablation(data, v2, { minProfiles: o.minProfiles ?? 5, excludeSeen: o.excludeSeen });
    log(o.json ? JSON.stringify(abl, null, 2) : formatAblation(abl));
    return 0;
  }
  const gateMargin = Number.isFinite(o.gateMargin) ? o.gateMargin : 0.05;
  const res = evaluate(data, { engines: o.engines ?? Object.keys(registry), registry, minProfiles: o.minProfiles ?? 5, excludeSeen: o.excludeSeen });
  res.meta.gateMargin = gateMargin;
  const g = gate(res, gateMargin);
  if (g) res.meta.gate = g;
  log(o.json ? JSON.stringify(res, null, 2) : format(res));
  return o.gate && g && !g.pass ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { out.error('reco-eval: ' + e.message); process.exit(2); });
}
