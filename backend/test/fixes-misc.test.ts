// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { PartyRegistry } from '../src/party.js';

const H = 3600_000;

describe('party registry expiry', () => {
  it('keeps a scheduled room alive until startAt + 6h, even when nobody joins or leaves', () => {
    const c = { t: 1_000_000 };
    const reg = new PartyRegistry(() => c.t);
    const room = reg.create({ id: 'sched', itemId: 'i', title: 'T', hostId: 'h', startAt: c.t + 24 * H });
    c.t += 23 * H;
    reg.tick();
    expect(reg.get('sched')).toBe(room); // not expired although created 23h ago
    room.join('h', 'H', () => undefined);
    room.leave('h');
    c.t += 11 * 60_000;
    reg.tick();
    expect(reg.get('sched')).toBe(room); // not idle-deleted before the party starts
    c.t = room.startAt! + 6 * H + 1;
    reg.tick();
    expect(reg.get('sched')).toBeUndefined(); // expires once the start window is over
  });
});
