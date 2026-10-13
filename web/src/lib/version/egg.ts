/** Tap counter of the version easter egg (7 taps like Android's build number; hint from the 4th tap). */
export const EGG_TAPS = 7;
/** a pause longer than this starts over */
export const EGG_RESET_MS = 2000;

export interface EggState { readonly count: number; readonly last: number }
export const EGG_START: EggState = { count: 0, last: 0 };

/**
 * One tap: the new state, how many taps are still missing (shown from the 4th tap on: "3 more…")
 * and whether the egg opens now (the counter then starts over).
 */
export function eggTap(s: EggState, now: number): { state: EggState; remaining: number | null; open: boolean } {
  const count = s.count && now - s.last <= EGG_RESET_MS ? s.count + 1 : 1;
  if (count >= EGG_TAPS) return { state: EGG_START, remaining: null, open: true };
  return { state: { count, last: now }, remaining: count >= 4 ? EGG_TAPS - count : null, open: false };
}
