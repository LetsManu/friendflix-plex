import { describe, expect, it } from 'vitest';
import { removeFromHistory, restoreRemoved } from './historyOps';

const E = (id: string, seriesId?: string) => ({ id, seriesId });
const all = [E('a'), E('b', 's1'), E('c', 's1'), E('d')];

describe('removeFromHistory', () => {
  it('removes a single item', () => expect(removeFromHistory(all, all[1]!, 'item').kept.map((x) => x.id)).toEqual(['a', 'c', 'd']));
  it('removes a whole series', () => expect(removeFromHistory(all, all[1]!, 'series').removed.map((x) => x.id)).toEqual(['b', 'c']));
});

describe('restoreRemoved', () => {
  it('restores only the failed removal and not a concurrent successful one', () => {
    const a = removeFromHistory(all, all[0]!, 'item'); // A: remove a
    const b = removeFromHistory(a.kept, all[3]!, 'item'); // B: remove d (succeeds)
    expect(restoreRemoved(b.kept, a.removed, all).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
  it('is a no-op when nothing else changed', () => {
    const a = removeFromHistory(all, all[2]!, 'item');
    expect(restoreRemoved(a.kept, a.removed, all)).toEqual(all);
  });
});
