import { describe, expect, it } from 'vitest';
import type { Item } from '#lib/api';
import { facts, hasPeople, otherTitles, peekPeople, type CastInfoData } from './castinfo';

const p = (n: number, role?: string) => ({ id: String(n).padStart(32, '0'), name: `P${n}`, image: false, ...(role ? { role } : {}) });
const base: CastInfoData = {
  item: { id: 'e1', name: 'Folge', type: 'Episode', year: 2017, rating: 'FSK-12', communityRating: 8.46, seriesId: 's1', seriesName: 'Dark' },
  cast: [p(1, 'Jonas'), p(2), p(3), p(4), p(5), p(6), p(7)], guests: [p(20, 'Polizist'), p(21), p(22)],
  directors: [p(30)], writers: [], creators: [p(31), p(32)], studios: ['Netflix-frei', 'W&B'], genres: ['Drama'], tags: ['a', 'b'],
};

describe('cast & info helpers', () => {
  it('peek: leading cast plus two guest stars, six at most', () => {
    expect(peekPeople(base).map((x) => x.name)).toEqual(['P1', 'P2', 'P3', 'P4', 'P20', 'P21']);
    expect(peekPeople({ ...base, guests: [] }).map((x) => x.name)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
    expect(hasPeople({ ...base, cast: [], guests: [] })).toBe(false);
  });
  it('person sheet hides the playing title and its series', () => {
    const items = [{ id: 'e1' }, { id: 's1' }, { id: 'm1' }, { id: 'm2' }] as Item[];
    expect(otherTitles(items, base.item).map((i) => i.id)).toEqual(['m1', 'm2']);
    expect(otherTitles(items, base.item, 1)).toHaveLength(1);
  });
  it('facts: only what the title has, in a fixed order', () => {
    const f = facts(base, (n) => String(n).replace('.', ','), (xs) => xs.join(' & '));
    expect(f.map((x) => x.key)).toEqual(['scenes.info.creators', 'scenes.info.directors', 'scenes.info.studio', 'scenes.info.year', 'scenes.info.rating', 'scenes.info.score', 'scenes.info.genres', 'scenes.info.tags']);
    expect(f.find((x) => x.key === 'scenes.info.score')!.text).toBe('★ 8,5');
    expect(f[0]!.text).toBe('P31 & P32');
    expect(facts({ ...base, directors: [], creators: [], studios: [], genres: [], tags: [], item: { id: 'x', name: 'x', type: 'Movie' } }, String, String)).toEqual([]);
  });
});
