// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { normaliseFmp4 } from '../src/fmp4.js';

const box = (type: string, ...body: Buffer[]) => {
  const b = Buffer.concat(body);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + b.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, b]);
};
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(n); return b; };
const tfhd = (track: number) => box('tfhd', u32(0), u32(track));
const tfdt0 = (t: number) => box('tfdt', u32(0), u32(t));
const tfdt1 = (t: bigint) => box('tfdt', u32(0x01000000), u64(t));
const moof = (...trafs: Buffer[]) => box('moof', box('mfhd', u32(0), u32(1)), ...trafs);
const traf = (track: number, tfdt: Buffer) => box('traf', tfhd(track), tfdt);
const sidx = (track: number, ept: bigint) => box('sidx', Buffer.concat([u32(0x01000000), u32(track), u32(90000), u64(ept), u64(0n), u32(0)]));
const sidxEpt = (b: Buffer, track: number) => { const i = b.indexOf('sidx') + 4; return b.readUInt32BE(i + 4) === track ? b.readBigUInt64BE(i + 12) : -1n; };
const mdat = box('mdat', Buffer.from('payload'));

/** reads every tfdt (track -> times) */
function times(buf: Buffer): Record<number, bigint[]> {
  const out: Record<number, bigint[]> = {};
  let p = 0;
  while (p < buf.length) {
    const size = buf.readUInt32BE(p);
    if (buf.toString('latin1', p + 4, p + 8) === 'moof') {
      let q = p + 8;
      while (q < p + size) {
        const qs = buf.readUInt32BE(q);
        if (buf.toString('latin1', q + 4, q + 8) === 'traf') {
          const tf = buf.indexOf('tfhd', q) - 4;
          const track = buf.readUInt32BE(tf + 12);
          const d = buf.indexOf('tfdt', q) - 4;
          const v1 = buf[d + 8] === 1;
          (out[track] ??= []).push(v1 ? buf.readBigUInt64BE(d + 12) : BigInt(buf.readUInt32BE(d + 12)));
        }
        q += qs;
      }
    }
    p += size;
  }
  return out;
}

describe('normaliseFmp4', () => {
  const init = Buffer.concat([box('ftyp', Buffer.from('iso5')), box('moov', Buffer.from('init'))]);

  it('rebases every track to its own first decode time (v0 and v1)', () => {
    const src = Buffer.concat([
      init,
      moof(traf(1, tfdt0(1_492_000)), traf(2, tfdt1(2_000_000_000_000n))), mdat,
      moof(traf(1, tfdt0(1_495_000)), traf(2, tfdt1(2_000_000_150_000n))), mdat,
    ]);
    const before = Buffer.from(src);
    const out = normaliseFmp4(src);
    expect(times(out)).toEqual({ 1: [0n, 3000n], 2: [0n, 150_000n] });
    expect(out.length).toBe(src.length);
    expect(src.equals(before)).toBe(true); // input untouched
    expect(out.subarray(0, init.length).equals(init)).toBe(true);
  });

  it('rebases sidx earliest_presentation_time by the track\'s first tfdt', () => {
    const src = Buffer.concat([init, sidx(1, 1_492_100n), moof(traf(1, tfdt0(1_492_000))), mdat]);
    expect(sidxEpt(normaliseFmp4(src), 1)).toBe(100n);
  });

  it('is idempotent and leaves non-fragmented input alone', () => {
    const src = Buffer.concat([init, moof(traf(1, tfdt0(5000))), mdat]);
    const once = normaliseFmp4(src);
    expect(normaliseFmp4(once).equals(once)).toBe(true);
    expect(normaliseFmp4(init).equals(init)).toBe(true);
    expect(normaliseFmp4(Buffer.from('garbage')).toString()).toBe('garbage');
  });
});
