// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AbrController, AUTO_MAX, LADDER, autoBps, isOriginalBps, pickRung, rungKey } from './abr';

function clock(t = 1_000_000) {
  const c = { t, now: () => c.t, adv: (ms: number) => { c.t += ms; } };
  return c;
}

describe('LADDER', () => {
  it('lists original then 1080p..360p', () => {
    expect(LADDER.map((r) => r.key)).toEqual(['original', '1080p', '720p', '480p', '360p']);
    expect(LADDER.map((r) => r.bps)).toEqual([Infinity, 8e6, 4e6, 1.5e6, 0.8e6]);
  });
});

describe('pickRung', () => {
  it('starts at 720p without an estimate', () => {
    expect(pickRung(null, 20e6)).toBe(4e6);
    expect(pickRung(null, 1.5e6)).toBe(1.5e6);
  });
  it('uses 70% of the estimate', () => {
    expect(pickRung(10e6, 20e6)).toBe(4e6);
    expect(pickRung(13e6, 20e6)).toBe(8e6);
  });
  it('never goes below 360p', () => {
    expect(pickRung(0.1e6, 20e6)).toBe(0.8e6);
    expect(pickRung(null, 0.1e6)).toBe(0.8e6);
  });
  it('picks original only when the source fits cap and estimate', () => {
    expect(pickRung(100e6, 20e6, 15e6)).toBe(Infinity);
    expect(pickRung(100e6, 8e6, 15e6)).toBe(8e6);
    expect(pickRung(20e6, 40e6, 15e6)).toBe(8e6); // 14 < 15
    expect(pickRung(100e6, 20e6)).toBe(8e6);
  });
});

describe('autoBps', () => {
  it('starts at 720p without an estimate', () => {
    expect(autoBps(null)).toBe(4e6);
  });
  it('uses the ladder while 70% of the estimate stays below 1080p', () => {
    expect(autoBps(10e6)).toBe(4e6);
    expect(autoBps(11.4e6)).toBe(4e6);
    expect(autoBps(0.1e6)).toBe(0.8e6);
  });
  it('asks for original (70% of the estimate) once that reaches the top rung, capped at 200 Mbit/s', () => {
    expect(autoBps(8e6 / 0.7)).toBe(Math.floor(8e6)); // boundary: exactly the top rung
    expect(autoBps(100e6)).toBe(70e6);
    expect(autoBps(1e9)).toBe(AUTO_MAX);
    expect(isOriginalBps(autoBps(100e6))).toBe(true);
    expect(isOriginalBps(8e6)).toBe(false);
  });
});

describe('rungKey', () => {
  it('labels by threshold like the server rung height', () => {
    expect(rungKey(20e6)).toBe('1080p');
    expect(rungKey(8e6)).toBe('1080p');
    expect(rungKey(7.9e6)).toBe('720p');
    expect(rungKey(4e6)).toBe('720p');
    expect(rungKey(2e6)).toBe('480p');
    expect(rungKey(1.5e6)).toBe('480p');
    expect(rungKey(1e6)).toBe('360p');
    expect(rungKey(0.5e6)).toBe('360p');
  });
});

describe('AbrController stalls', () => {
  it('starts at the auto rung, or at pinned', () => {
    expect(new AbrController({ now: clock().now, cap: 20e6 }).current).toBe(4e6);
    expect(new AbrController({ now: clock().now, cap: 20e6, pinned: 8e6 }).current).toBe(8e6);
  });
  it('steps down on a 2.5 s stall', () => {
    const a = new AbrController({ now: clock().now, cap: 20e6 });
    expect(a.onStall(2500)).toEqual({ do: 'switch', bps: 1.5e6, reason: 'stall' });
    expect(a.current).toBe(1.5e6);
  });
  it('ignores a single short stall', () => {
    const a = new AbrController({ now: clock().now, cap: 20e6 });
    expect(a.onStall(1000)).toEqual({ do: 'none' });
  });
  it('steps down on 3 stalls of 1 s within 60 s', () => {
    const c = clock();
    const a = new AbrController({ now: c.now, cap: 20e6 });
    expect(a.onStall(1000)).toEqual({ do: 'none' });
    c.adv(20_000);
    expect(a.onStall(1000)).toEqual({ do: 'none' });
    c.adv(20_000);
    expect(a.onStall(1000)).toEqual({ do: 'switch', bps: 1.5e6, reason: 'stall' });
  });
  it('does not count stalls older than 60 s', () => {
    const c = clock();
    const a = new AbrController({ now: c.now, cap: 20e6 });
    a.onStall(1000);
    c.adv(40_000);
    a.onStall(1000);
    c.adv(40_000);
    expect(a.onStall(1000)).toEqual({ do: 'none' });
  });
  it('a second step-down within 10 s is none, after 10 s it works', () => {
    const c = clock();
    const a = new AbrController({ now: c.now, cap: 20e6 });
    expect(a.onStall(3000).do).toBe('switch');
    c.adv(5000);
    expect(a.onStall(3000)).toEqual({ do: 'none' });
    c.adv(5000);
    expect(a.onStall(3000)).toEqual({ do: 'switch', bps: 0.8e6, reason: 'stall' });
  });
  it('fails on a stall at 360p', () => {
    const a = new AbrController({ now: clock().now, cap: 20e6, pinned: 0.8e6 });
    expect(a.onStall(3000)).toEqual({ do: 'fail' });
  });
  it('steps down from original to 1080p', () => {
    const a = new AbrController({ now: clock().now, cap: 20e6, pinned: Infinity });
    expect(a.onStall(3000)).toEqual({ do: 'switch', bps: 8e6, reason: 'stall' });
  });
});

describe('AbrController floor and cooldown', () => {
  it('a stall at the floor is none during the cooldown, fail after it', () => {
    const c = clock();
    const a = new AbrController({ now: c.now, cap: 20e6, pinned: 1.5e6 });
    expect(a.onStall(3000).do).toBe('switch'); // now 360p
    c.adv(1000);
    expect(a.onStall(3000)).toEqual({ do: 'none' });
    c.adv(9000);
    expect(a.onStall(3000)).toEqual({ do: 'fail' });
  });
  it('a step-down never lands above the cap; pinned is clamped to it', () => {
    const a = new AbrController({ now: clock().now, cap: 4e6, pinned: Infinity });
    expect(a.current).toBe(4e6);
    expect(a.onStall(3000)).toEqual({ do: 'switch', bps: 1.5e6, reason: 'stall' });
  });
  it('a step-down resets the step-up window', () => {
    const c = clock();
    const a = new AbrController({ now: c.now, cap: 20e6 });
    a.onTick({ estimate: 14e6, bufferSec: 30 });
    c.adv(20_000);
    a.onStall(3000); // down to 480p, window must restart
    c.adv(11_000); // 31 s since first qualifying tick
    expect(a.onTick({ estimate: 14e6, bufferSec: 30 })).toEqual({ do: 'none' });
    c.adv(29_000);
    expect(a.onTick({ estimate: 14e6, bufferSec: 30 })).toEqual({ do: 'none' });
    c.adv(1000);
    expect(a.onTick({ estimate: 14e6, bufferSec: 30 }).do).toBe('switch');
  });
});

describe('AbrController network errors', () => {
  it('steps down; the cooldown holds the same rung; then fails at the floor', () => {
    const c = clock();
    const a = new AbrController({ now: c.now, cap: 20e6, pinned: 1.5e6 });
    expect(a.onNetworkError()).toEqual({ do: 'switch', bps: 0.8e6, reason: 'network' });
    c.adv(1000);
    expect(a.onNetworkError()).toEqual({ do: 'none' });
    expect(a.current).toBe(0.8e6);
    c.adv(9000);
    expect(a.onNetworkError()).toEqual({ do: 'fail' });
  });
});

describe('AbrController step-up', () => {
  const tick = (a: AbrController, estimate: number | null, bufferSec = 30) => a.onTick({ estimate, bufferSec });

  it('steps up after 30 s of estimate >= next/0.6 with buffer >= 20 s', () => {
    const c = clock();
    const a = new AbrController({ now: c.now, cap: 20e6 }); // 720p, next 1080p needs 13.34e6
    expect(tick(a, 14e6)).toEqual({ do: 'none' });
    c.adv(29_000);
    expect(tick(a, 14e6)).toEqual({ do: 'none' });
    c.adv(1000);
    expect(tick(a, 14e6)).toEqual({ do: 'switch', bps: 8e6, reason: 'up' });
    expect(a.current).toBe(8e6);
  });
  it('a dip below the threshold resets the window', () => {
    const c = clock();
    const a = new AbrController({ now: c.now, cap: 20e6 });
    tick(a, 14e6);
    c.adv(20_000);
    tick(a, 10e6);
    c.adv(20_000);
    expect(tick(a, 14e6)).toEqual({ do: 'none' });
    c.adv(29_000);
    expect(tick(a, 14e6)).toEqual({ do: 'none' });
    c.adv(1000);
    expect(tick(a, 14e6).do).toBe('switch');
  });
  it('needs a buffer of 20 s', () => {
    const c = clock();
    const a = new AbrController({ now: c.now, cap: 20e6 });
    tick(a, 14e6, 5);
    c.adv(40_000);
    expect(tick(a, 14e6, 5)).toEqual({ do: 'none' });
    expect(tick(a, 14e6, 25).do).toBe('switch');
  });
  it('steps up at most once per 60 s', () => {
    const c = clock();
    const a = new AbrController({ now: c.now, cap: 20e6 });
    // start lower: stall to 480p, wait out cooldown, then climb
    a.onStall(3000);
    expect(a.current).toBe(1.5e6); // next 720p needs 6.67e6
    c.adv(11_000);
    tick(a, 20e6);
    c.adv(30_000);
    expect(tick(a, 20e6)).toEqual({ do: 'switch', bps: 4e6, reason: 'up' });
    // next 1080p: window restarts, ready after 30 s but blocked until 60 s since the last up
    expect(tick(a, 20e6)).toEqual({ do: 'none' });
    c.adv(30_000);
    expect(tick(a, 20e6)).toEqual({ do: 'none' });
    c.adv(29_000);
    expect(tick(a, 20e6)).toEqual({ do: 'none' });
    c.adv(1000);
    expect(tick(a, 20e6)).toEqual({ do: 'switch', bps: 8e6, reason: 'up' });
  });
  it('never steps above the cap or past the top finite rung', () => {
    const c = clock();
    const a = new AbrController({ now: c.now, cap: 4e6 });
    tick(a, 100e6);
    c.adv(60_000);
    expect(tick(a, 100e6)).toEqual({ do: 'none' });
    const b = new AbrController({ now: c.now, cap: 20e6 });
    tick(b, null);
    c.adv(60_000);
    expect(tick(b, null)).toEqual({ do: 'none' });
  });
  it('steps up from the top rung to original (the ceiling) when the estimate allows it', () => {
    const c = clock();
    const a = new AbrController({ now: c.now, cap: 20e6, start: 8e6 }); // original = 20e6 needs 33.4e6
    tick(a, 30e6);
    c.adv(60_000);
    expect(tick(a, 30e6)).toEqual({ do: 'none' });
    tick(a, 40e6);
    c.adv(30_000);
    expect(tick(a, 40e6)).toEqual({ do: 'switch', bps: 20e6, reason: 'up' });
    expect(a.current).toBe(20e6);
    c.adv(120_000);
    expect(tick(a, 400e6)).toEqual({ do: 'none' }); // already at the ceiling
    expect(a.onStall(3000)).toEqual({ do: 'switch', bps: 8e6, reason: 'stall' });
  });
  it('an Auto start above the cap begins at the ceiling; an unknown cap tops out at 200 Mbit/s', () => {
    expect(new AbrController({ now: () => 0, cap: 12e6, start: autoBps(100e6) }).current).toBe(12e6);
    const c = clock();
    const a = new AbrController({ now: c.now, cap: Infinity, start: 8e6 });
    tick(a, 400e6);
    c.adv(30_000);
    expect(tick(a, 400e6)).toEqual({ do: 'switch', bps: AUTO_MAX, reason: 'up' });
  });
  it('pinned: never steps up, still steps down on stall', () => {
    const c = clock();
    const a = new AbrController({ now: c.now, cap: 20e6, pinned: 1.5e6 });
    tick(a, 100e6);
    c.adv(120_000);
    expect(tick(a, 100e6)).toEqual({ do: 'none' });
    expect(a.onStall(3000)).toEqual({ do: 'switch', bps: 0.8e6, reason: 'stall' });
  });
});

describe('AbrController start rung', () => {
  it('starts at the requested rung, clamped to the cap and the floor', () => {
    expect(new AbrController({ now: () => 0, cap: 20e6, start: 8e6 }).current).toBe(8e6);
    expect(new AbrController({ now: () => 0, cap: 4e6, start: Infinity }).current).toBe(4e6);
    expect(new AbrController({ now: () => 0, cap: 20e6, start: 1 }).current).toBe(800_000);
    expect(new AbrController({ now: () => 0, cap: 20e6 }).current).toBe(4e6);
  });
});
