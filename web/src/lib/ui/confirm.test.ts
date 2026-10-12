import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import { answer, confirm, confirmRequest, registerHost, typedOk } from './confirm';

describe('confirm', () => {
  it('resolves false without a host (nothing destructive runs by accident)', async () => {
    expect(await confirm({ title: 'Löschen?' })).toBe(false);
  });
  it('queues requests and resolves each with its answer', async () => {
    const off = registerHost();
    const a = confirm({ title: 'A', danger: true });
    const b = confirm({ title: 'B' });
    expect(get(confirmRequest)?.title).toBe('A');
    answer(true);
    expect(await a).toBe(true);
    expect(get(confirmRequest)?.title).toBe('B');
    answer(false);
    expect(await b).toBe(false);
    expect(get(confirmRequest)).toBeNull();
    off();
  });
  it('unmounting the host cancels open requests', async () => {
    const off = registerHost();
    const a = confirm({ title: 'A' });
    off();
    expect(await a).toBe(false);
  });
  it('typed confirmation ignores case and outer spaces', () => {
    expect(typedOk(undefined, '')).toBe(true);
    expect(typedOk('Anna', 'ann')).toBe(false);
    expect(typedOk('Anna', ' anna ')).toBe(true);
  });
});
