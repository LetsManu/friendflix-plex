// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Pure helpers behind DataTable.svelte (filter, sort, page); unit-tested in table.test.ts. */

export type SortDir = 'asc' | 'desc';
export interface Column<T> {
  /** unique id (also the sort key in server mode) */
  key: string;
  label: string;
  /** cell text; also used to sort and filter unless `sort` / `filter: false` say otherwise */
  value?: (row: T) => string | number | boolean | Date | null | undefined;
  /** default: true when `value` or `sort` exists */
  sortable?: boolean;
  /** custom comparator (ascending) */
  sort?: (a: T, b: T) => number;
  /** false: the text filter ignores this column */
  filter?: boolean;
  align?: 'start' | 'end' | 'center';
  /** CSS width of the column on desktop, e.g. '8rem' */
  width?: string;
  /** phone card: shown as the card title (no label) */
  primary?: boolean;
  /** phone card: not shown */
  hideOnCard?: boolean;
  /** desktop header: label only for screen readers (narrow columns such as a row checkbox) */
  hideLabel?: boolean;
}
export interface SortState { key: string; dir: SortDir }
export interface Query { q: string; sort: SortState | null; offset: number; limit: number }

const norm = (s: string): string => s.toLocaleLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function cellText<T>(c: Column<T>, r: T): string {
  const v = c.value?.(r);
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** rows whose filterable columns contain every word of `q` (case- and accent-insensitive) */
export function filterRows<T>(rows: readonly T[], cols: readonly Column<T>[], q: string, text?: (r: T) => string): T[] {
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return [...rows];
  const fcols = cols.filter((c) => c.filter !== false && c.value);
  return rows.filter((r) => {
    const hay = norm(text ? text(r) : fcols.map((c) => cellText(c, r)).join(' '));
    return words.every((w) => hay.includes(w));
  });
}

const collator = (): Intl.Collator => new Intl.Collator(typeof document !== 'undefined' ? document.documentElement.lang || undefined : undefined, { numeric: true, sensitivity: 'base' });

/** stable sort by one column; empty values always last */
export function sortRows<T>(rows: readonly T[], cols: readonly Column<T>[], s: SortState | null): T[] {
  const c = s && cols.find((x) => x.key === s.key);
  if (!c || !s) return [...rows];
  const sign = s.dir === 'asc' ? 1 : -1;
  const coll = collator();
  const cmp = c.sort ?? ((a: T, b: T) => {
    const va = c.value?.(a), vb = c.value?.(b);
    if (typeof va === 'number' && typeof vb === 'number') return va - vb;
    if (va instanceof Date && vb instanceof Date) return va.getTime() - vb.getTime();
    if (typeof va === 'boolean' && typeof vb === 'boolean') return Number(va) - Number(vb);
    return coll.compare(String(va ?? ''), String(vb ?? ''));
  });
  const empty = (r: T) => { const v = c.value?.(r); return !c.sort && (v === null || v === undefined || v === ''); };
  return rows.map((r, i) => [r, i] as const).sort(([a, ia], [b, ib]) => {
    const ea = empty(a), eb = empty(b);
    if (ea !== eb) return ea ? 1 : -1;
    return (ea ? 0 : sign * cmp(a, b)) || ia - ib;
  }).map(([r]) => r);
}

/** next sort state when a header is clicked: asc → desc → off */
export function nextSort(cur: SortState | null, key: string): SortState | null {
  if (!cur || cur.key !== key) return { key, dir: 'asc' };
  return cur.dir === 'asc' ? { key, dir: 'desc' } : null;
}

export interface PageInfo { from: number; to: number; total: number; page: number; pages: number }
/** 0-based page clamped to the available pages; pageSize 0 = everything on one page */
export function pageInfo(total: number, page: number, pageSize: number): PageInfo {
  if (!pageSize) return { from: total ? 1 : 0, to: total, total, page: 0, pages: 1 };
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { from: total ? p * pageSize + 1 : 0, to: Math.min(total, (p + 1) * pageSize), total, page: p, pages };
}
