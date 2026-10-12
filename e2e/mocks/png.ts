import { deflateSync } from 'node:zlib';

// Tiny PNG encoder so no binary fixtures are committed: /media/** is answered with a generated solid-colour image.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Buffer): number {
  let c = ~0;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 255]! ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Solid-colour 8-bit RGB PNG. */
export function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const row = Buffer.concat([Buffer.from([0]), ...Array.from({ length: width }, () => Buffer.from(rgb))]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Deterministic colour per URL so different posters look different but runs are reproducible. */
export function pngFor(url: string): Buffer {
  return png(16, 9, [(url.length * 37) % 200 + 30, (url.length * 91) % 160 + 40, (url.length * 53) % 200 + 30]);
}
