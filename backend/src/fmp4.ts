/**
 * Rebases a fragmented MP4 to start at 0: Jellyfin keeps the source timestamps in the fragments (a clip cut at 1492 s
 * starts at 1492 s), which gives browsers an empty timeline and breaks `loop`. For every track the first
 * baseMediaDecodeTime (moof > traf > tfdt) is subtracted from all of that track's fragments (and from its sidx boxes). Pure; returns a copy.
 */
export function normaliseFmp4(input: Uint8Array): Buffer {
  const buf = Buffer.from(input); // copy
  const first = new Map<number, bigint>();

  /** Calls fn(type, bodyStart, end) for each box in [from, to). */
  const boxes = (from: number, to: number, fn: (type: string, body: number, end: number) => void) => {
    let p = from;
    while (p + 8 <= to) {
      let size = buf.readUInt32BE(p);
      const type = buf.toString('latin1', p + 4, p + 8);
      let head = 8;
      if (size === 1) {
        if (p + 16 > to) return;
        size = Number(buf.readBigUInt64BE(p + 8));
        head = 16;
      } else if (size === 0) size = to - p;
      if (size < head || p + size > to) return; // truncated/garbage: leave the rest untouched
      fn(type, p + head, p + size);
      p += size;
    }
  };

  boxes(0, buf.length, (type, body, end) => {
    if (type !== 'moof') return;
    boxes(body, end, (kind, b, e) => {
      if (kind !== 'traf') return;
      let track = 0;
      let tfdt = -1;
      boxes(b, e, (tt, tb) => {
        if (tt === 'tfhd') track = buf.readUInt32BE(tb + 4);
        else if (tt === 'tfdt') tfdt = tb;
      });
      if (tfdt < 0) return;
      const v1 = buf[tfdt] === 1;
      const t0 = v1 ? buf.readBigUInt64BE(tfdt + 4) : BigInt(buf.readUInt32BE(tfdt + 4));
      if (!first.has(track)) first.set(track, t0);
      const t = t0 - first.get(track)!;
      if (v1) buf.writeBigUInt64BE(t < 0n ? 0n : t, tfdt + 4);
      else buf.writeUInt32BE(Number(t < 0n ? 0n : t), tfdt + 4);
    });
  });
  // segment index boxes (one per track, reference_ID = track_ID) carry the same absolute times: rebase them by the same amount
  boxes(0, buf.length, (type, body) => {
    if (type !== 'sidx') return;
    const base = first.get(buf.readUInt32BE(body + 4));
    if (base === undefined) return;
    const at = body + 12; // version/flags, reference_ID, timescale
    if (buf[body] === 1) {
      const t = buf.readBigUInt64BE(at) - base;
      buf.writeBigUInt64BE(t < 0n ? 0n : t, at);
    } else {
      const t = BigInt(buf.readUInt32BE(at)) - base;
      buf.writeUInt32BE(Number(t < 0n ? 0n : t), at);
    }
  });
  return buf;
}
