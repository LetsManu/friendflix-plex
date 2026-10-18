// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Recommendation engine v2, item index maths (pure functions, no I/O): tokenising, TF-IDF over overview + tagline, IDF for the
 * categorical features and standardised numerics. Used by indexJob.ts; unit-tested in test/reco-tfidf.test.ts.
 */

/** Terms kept per item (spec §4.2) */
export const TOP_TERMS = 40;
/** Terms shorter than this are noise ("im", "de", "of") */
const MIN_TERM_LEN = 3;
/** On a corpus of at least this many items a term seen in one item only cannot be shared with another, so it does not take a top-40 slot */
const MIN_DF_FROM_N = 20;

/** Small stop list for the instance languages that matter most (en, de, fr, es, it); IDF removes the rest on any real library. */
const STOP = new Set(`
the and for are but not you all any can had her was one our out has have his how its may new now old see two who boy did get let say she too use
with that this from they will been were into over than then them what when where which while about after again against because before being below
between both could does doing down during each few further here hers himself itself more most once only other ours same should some such their there
these those through under until very would your also just like
der die das und ein eine einer eines einem einen ist sind war waren wird werden wurde wurden hat haben hatte nicht auch aber oder wenn dann dass
mit von für auf aus bei nach über unter vor zum zur als wie nur noch sich sein seine ihr ihre ihrem ihren ihrer des dem den im am es er sie wir
les des une est dans pour que qui par sur pas plus son ses sont avec cette elle ils elles nous vous mais
los las del una por con para que como pero sus este esta son
il lo gli che per con una non del della sono più
`.split(/\s+/).filter(Boolean));

/** Lower-cased word tokens (letters and digits of any script), without stop words, short words and bare numbers. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize('NFKC').toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const t = m[0];
    if (t.length < MIN_TERM_LEN || STOP.has(t) || /^\p{N}+$/u.test(t)) continue;
    out.push(t);
  }
  return out;
}

/** Term -> count of one document. */
export function termCounts(tokens: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Smoothed inverse document frequency: always >= 1, so a term in every item still counts a little and never goes negative. */
export function idf(n: number, df: number): number {
  return Math.log((n + 1) / (df + 1)) + 1;
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/**
 * The item's sparse vector: sublinear tf (1 + ln count) times idf, the best `max` terms, L2-normalised (cosine is then a dot product).
 * `dfOf` = document frequency of a term in the corpus of `n` items, counting this item. Ties break alphabetically (stable output).
 */
export function topTerms(counts: ReadonlyMap<string, number>, n: number, dfOf: (term: string) => number, max = TOP_TERMS): Record<string, number> {
  const scored: Array<[string, number]> = [];
  for (const [term, c] of counts) {
    const df = dfOf(term);
    if (n >= MIN_DF_FROM_N && df < 2) continue;
    scored.push([term, (1 + Math.log(c)) * idf(n, df)]);
  }
  scored.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const best = scored.slice(0, max);
  const norm = Math.sqrt(best.reduce((s, [, w]) => s + w * w, 0));
  const out: Record<string, number> = {};
  if (norm > 0) for (const [t, w] of best) out[t] = round4(w / norm);
  return out;
}

/** Document frequency of every term over a corpus of term-count maps. */
export function documentFrequencies(docs: Iterable<ReadonlyMap<string, number>>): Map<string, number> {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  return df;
}

/** Categorical value as stored and counted: trimmed, Unicode-normalised, lower-cased ("Drama" and "drama " are one value). */
export function normValue(v: string): string {
  return v.normalize('NFKC').trim().toLowerCase();
}

/** normValue over a list: empty values dropped, duplicates removed, at most `max` kept in the given order. */
export function normList(list: readonly string[], max: number): string[] {
  const out: string[] = [];
  for (const v of list) {
    const n = normValue(v).slice(0, 120);
    if (n && !out.includes(n)) out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

export interface NumStat { mean: number; std: number; n: number }

/** Mean and sample standard deviation of the finite values (std 0 for fewer than 2). */
export function numStat(values: ReadonlyArray<number | null | undefined>): NumStat {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return { mean: 0, std: 0, n: 0 };
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const std = v.length > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1)) : 0;
  return { mean, std, n: v.length };
}

/** Standardised value; 0 (the average) when the value is missing or the feature has no spread. */
export function zscore(x: number | null | undefined, s: NumStat): number {
  if (typeof x !== 'number' || !Number.isFinite(x) || s.std <= 0) return 0;
  return (x - s.mean) / s.std;
}
