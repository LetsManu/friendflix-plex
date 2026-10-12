import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { FastifyReply, FastifyRequest } from 'fastify';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** JSON bodies below this size are sent as-is (compression would not pay off). */
export const COMPRESS_MIN_BYTES = 1024;

/** 'br' | 'gzip' | null from an Accept-Encoding header (q=0 means "not acceptable"; brotli preferred). */
export function pickEncoding(header: string | string[] | undefined): 'br' | 'gzip' | null {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return null;
  const ok = new Set<string>();
  for (const part of raw.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
    if (name && (q === undefined || Number(q) > 0)) ok.add(name.trim());
  }
  if (ok.has('br')) return 'br';
  if (ok.has('gzip') || ok.has('*')) return 'gzip';
  return null;
}

const appendVary = (reply: FastifyReply, v: string) => {
  const cur = reply.getHeader('vary');
  const list = (Array.isArray(cur) ? cur.join(',') : cur === undefined ? '' : String(cur)).split(',').map((x) => x.trim()).filter(Boolean);
  if (list.includes('*') || list.some((x) => x.toLowerCase() === v.toLowerCase())) return;
  reply.header('vary', [...list, v].join(', '));
};

/**
 * onSend payload transform: compresses JSON (string/Buffer) bodies >= 1 KB with brotli (quality 4) or gzip (level 6).
 * Streams, non-JSON types (SSE, media, files), HEAD, already encoded bodies and 204/304 pass through untouched.
 */
export async function compressJson(req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload;
  if (req.method === 'HEAD' || reply.statusCode === 204 || reply.statusCode === 304) return payload;
  const type = String(reply.getHeader('content-type') ?? '');
  if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(type)) return payload;
  if (reply.getHeader('content-encoding') !== undefined) return payload;
  const size = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length;
  if (size < COMPRESS_MIN_BYTES) return payload;
  appendVary(reply, 'Accept-Encoding'); // the representation depends on the header even when this client gets identity
  const enc = pickEncoding(req.headers['accept-encoding']);
  if (!enc) return payload;
  const buf = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const out = enc === 'br'
    ? await brotli(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } })
    : await gz(buf, { level: 6 });
  reply.header('content-encoding', enc);
  reply.removeHeader('content-length');
  return out;
}
