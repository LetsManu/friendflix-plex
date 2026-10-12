import { describe, expect, it } from 'vitest';
import { filterRows, nextSort, pageInfo, sortRows, type Column } from './table';

type R = { name: string; n: number | null; at?: Date };
const rows: R[] = [{ name: 'Zoë', n: 3 }, { name: 'anna', n: null }, { name: 'Ben', n: 10 }, { name: 'Émile', n: 2 }];
const cols: Column<R>[] = [{ key: 'name', label: 'Name', value: (r) => r.name }, { key: 'n', label: 'N', value: (r) => r.n }];

describe('table helpers', () => {
  it('filters case- and accent-insensitively, all words must match', () => {
    expect(filterRows(rows, cols, 'emi').map((r) => r.name)).toEqual(['Émile']);
    expect(filterRows(rows, cols, 'zoe 3').map((r) => r.name)).toEqual(['Zoë']);
    expect(filterRows(rows, cols, '  ')).toHaveLength(4);
    expect(filterRows(rows, cols, 'x', (r) => r.name + ' x')).toHaveLength(4);
  });
  it('sorts text naturally and numbers numerically, empty values last in both directions', () => {
    expect(sortRows(rows, cols, { key: 'name', dir: 'asc' }).map((r) => r.name)).toEqual(['anna', 'Ben', 'Émile', 'Zoë']);
    expect(sortRows(rows, cols, { key: 'n', dir: 'asc' }).map((r) => r.n)).toEqual([2, 3, 10, null]);
    expect(sortRows(rows, cols, { key: 'n', dir: 'desc' }).map((r) => r.n)).toEqual([10, 3, 2, null]);
    expect(sortRows(rows, cols, null)).toEqual(rows);
  });
  it('cycles sort asc → desc → off', () => {
    expect(nextSort(null, 'a')).toEqual({ key: 'a', dir: 'asc' });
    expect(nextSort({ key: 'a', dir: 'asc' }, 'a')).toEqual({ key: 'a', dir: 'desc' });
    expect(nextSort({ key: 'a', dir: 'desc' }, 'a')).toBeNull();
    expect(nextSort({ key: 'a', dir: 'desc' }, 'b')).toEqual({ key: 'b', dir: 'asc' });
  });
  it('computes page ranges and clamps the page', () => {
    expect(pageInfo(120, 0, 25)).toEqual({ from: 1, to: 25, total: 120, page: 0, pages: 5 });
    expect(pageInfo(120, 9, 25)).toEqual({ from: 101, to: 120, total: 120, page: 4, pages: 5 });
    expect(pageInfo(0, 3, 25)).toEqual({ from: 0, to: 0, total: 0, page: 0, pages: 1 });
    expect(pageInfo(7, 0, 0)).toEqual({ from: 1, to: 7, total: 7, page: 0, pages: 1 });
  });
});
