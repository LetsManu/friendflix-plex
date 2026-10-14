// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Writable } from 'svelte/store';

const { session, playOnTv, info, noteInteraction } = vi.hoisted(() => ({ session: { current: null as unknown }, playOnTv: vi.fn(async () => {}), info: vi.fn(), noteInteraction: vi.fn() }));
vi.mock('./engine', async () => {
  const { writable } = await import('svelte/store');
  session.current = writable<{ device: string } | null>(null);
  return { castSession: { subscribe: (session.current as Writable<unknown>).subscribe }, castEngine: { playOnTv } };
});
vi.mock('#lib/ui/toast', () => ({ toast: { info } }));
vi.mock('#lib/stillwatching', () => ({ noteInteraction }));

import { playOrCast } from './playOrCast';

const ev = (o: Partial<MouseEvent> = {}) => ({ button: 0, defaultPrevented: false, preventDefault: vi.fn(), ...o }) as unknown as MouseEvent;

describe('playOrCast', () => {
  beforeEach(() => { (session.current as Writable<unknown>).set(null); playOnTv.mockClear(); info.mockClear(); noteInteraction.mockClear(); });

  it('does nothing without a session', () => {
    const e = ev();
    expect(playOrCast(e, { id: 'e1' })).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(playOnTv).not.toHaveBeenCalled();
    expect(noteInteraction).not.toHaveBeenCalled();
  });

  it('casts with the resume position and toasts', () => {
    (session.current as Writable<unknown>).set({ device: 'Wohnzimmer-TV' });
    const e = ev();
    expect(playOrCast(e, { id: 'e1', positionTicks: 1_200_000_000 })).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(playOnTv).toHaveBeenCalledWith('e1', 120);
    expect(info).toHaveBeenCalledWith('Läuft auf Wohnzimmer-TV');
    expect(noteInteraction).toHaveBeenCalledTimes(1); // a tap: the viewer is there (still-watching)
  });

  it('no position = server resume', () => {
    (session.current as Writable<unknown>).set({ device: 'TV' });
    playOrCast(ev(), { id: 'e1' });
    expect(playOnTv).toHaveBeenCalledWith('e1', undefined);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }])('leaves %o to the browser', (o) => {
    (session.current as Writable<unknown>).set({ device: 'TV' });
    const e = ev(o as Partial<MouseEvent>);
    expect(playOrCast(e, { id: 'e1' })).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(playOnTv).not.toHaveBeenCalled();
  });
});
