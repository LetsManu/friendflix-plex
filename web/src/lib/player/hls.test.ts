import { describe, expect, it, vi } from 'vitest';
import { hlsConfig, loadHls, resetHlsLoader } from './hls';

describe('loadHls', () => {
  it('loads once and shares the promise', async () => {
    resetHlsLoader();
    const Fake = class {} as any;
    const imp = vi.fn(async () => ({ default: Fake }));
    const [a, b] = await Promise.all([loadHls(imp), loadHls(imp)]);
    expect(a).toBe(Fake); expect(b).toBe(Fake);
    expect(imp).toHaveBeenCalledTimes(1);
    await loadHls(imp);
    expect(imp).toHaveBeenCalledTimes(1);
  });
  it('a failed load can be retried', async () => {
    resetHlsLoader();
    const Fake = class {} as any;
    const imp = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ default: Fake });
    await expect(loadHls(imp)).rejects.toThrow('offline');
    await expect(loadHls(imp)).resolves.toBe(Fake);
    expect(imp).toHaveBeenCalledTimes(2);
  });
});

describe('hlsConfig', () => {
  it('starts at the resume point (or live edge = -1) and sets the buffer tuning', () => {
    expect(hlsConfig(0).startPosition).toBe(-1);
    expect(hlsConfig(1).startPosition).toBe(-1);
    expect(hlsConfig(95)).toMatchObject({ startPosition: 95, startFragPrefetch: true, backBufferLength: 90, maxMaxBufferLength: 60, maxBufferLength: 30 });
  });
});
