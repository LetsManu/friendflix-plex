// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Defensive helpers for the detail page: one odd field of one title (a cast entry without a name, the same title twice in a list, an
 * "about" answer with a missing list) must never throw while rendering. A throw there ends in SvelteKit's "Internal Error" page, and a
 * keyed `{#each}` with a duplicate key throws in production too (svelte.dev/e/each_key_duplicate).
 */
import type { Person } from '#lib/detail/format';

/** The entries of `list` with a non-empty key, first one of each key wins; anything that is not an array gives []. */
export function uniqueBy<T>(list: readonly T[] | null | undefined, key: (x: T) => unknown): T[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<unknown>();
  const out: T[] = [];
  for (const x of list) {
    if (x === null || x === undefined) continue;
    const k = key(x);
    if (k === undefined || k === null || k === '' || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/** "Lena Doria" -> "LD"; '' for a missing or empty name. */
export function initials(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]!.toUpperCase()).join('');
}

/** Cast & crew as the page uses them: entries need a string id; a missing name becomes '', a missing type 'Actor'. */
export function toPeople(raw: unknown): Person[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p: unknown): Person[] => {
    if (!p || typeof p !== 'object') return [];
    const o = p as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) return [];
    return [{
      id: o.id,
      name: typeof o.name === 'string' ? o.name : '',
      ...(typeof o.role === 'string' && o.role ? { role: o.role } : {}),
      type: typeof o.type === 'string' && o.type ? o.type : 'Actor',
      image: Boolean(o.image),
    }];
  });
}

/** Only strings, empty ones dropped (lists from external sources). */
export const strings = (a: unknown): string[] => (Array.isArray(a) ? a.filter((s): s is string => typeof s === 'string' && s !== '') : []);
