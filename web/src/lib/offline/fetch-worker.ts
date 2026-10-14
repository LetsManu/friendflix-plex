// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="webworker" />
// Dedicated module worker: downloads /media/d/<id> into OPFS with Range resume. One download at a time.
// Protocol (main -> worker): {cmd:'start', id, url, have, etag, total, extras:[{url,name}]} | {cmd:'pause'}
// (worker -> main): {type:'progress', id, have, total, etag} | {type:'done', id, bytes, etag}
//                   | {type:'paused', id, have} | {type:'error', id, code, message}
// messages are technical (logs); the manager shows translated texts per code
// error codes: auth (401, sign in again) | busy (429) | gone (403/404/410) | network | size | io

export interface StartMsg { cmd: 'start'; id: string; url: string; have: number; etag: string; total: number; extras: Array<{ url: string; name: string }> }
export type WorkerOut =
  | { type: 'progress'; id: string; have: number; total: number; etag: string }
  | { type: 'done'; id: string; bytes: number; etag: string }
  | { type: 'paused'; id: string; have: number }
  | { type: 'error'; id: string; code: 'auth' | 'busy' | 'gone' | 'network' | 'size' | 'io'; message: string };

const FLUSH_EVERY = 8 * 1024 * 1024;
const ctx = self as unknown as DedicatedWorkerGlobalScope;
let abort: AbortController | null = null;
const post = (m: WorkerOut) => ctx.postMessage(m);

class Fail extends Error { constructor(public code: Extract<WorkerOut, { type: 'error' }>['code'], msg: string) { super(msg); } }

async function dir(id: string) {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('ff-dl', { create: true });
  return root.getDirectoryHandle(id, { create: true });
}

/** small side files (subtitles, poster, backdrop): best effort, never fails the download */
async function fetchExtras(d: FileSystemDirectoryHandle, extras: StartMsg['extras'], signal: AbortSignal) {
  for (const x of extras) {
    if (signal.aborted) return;
    try {
      const fh = await d.getFileHandle(x.name, { create: true });
      try { if ((await fh.getFile()).size > 0) continue; } catch { /* write anew */ }
      const r = await fetch(x.url, { credentials: 'same-origin', signal });
      if (!r.ok) continue;
      const buf = await r.arrayBuffer();
      const h = await fh.createSyncAccessHandle();
      try { h.truncate(0); h.write(new Uint8Array(buf), { at: 0 }); h.flush(); } finally { h.close(); }
    } catch { /* ignore */ }
  }
}

async function run(m: StartMsg) {
  abort = new AbortController();
  const { signal } = abort;
  const d = await dir(m.id);
  await fetchExtras(d, m.extras, signal);
  const fh = await d.getFileHandle('video.mp4', { create: true });
  const h = await fh.createSyncAccessHandle();
  let have = Math.min(m.have, h.getSize()); // never trust more than what is really on disk
  let etag = m.etag, total = m.total, sinceFlush = 0, lastPost = 0;
  const restart = () => { h.truncate(0); have = 0; sinceFlush = 0; };
  try {
    if (have === 0) h.truncate(0);
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers: Record<string, string> = {};
      if (have > 0) { headers['range'] = `bytes=${have}-`; if (etag) headers['if-range'] = etag; }
      let res: Response;
      try { res = await fetch(m.url, { credentials: 'same-origin', headers, signal }); }
      catch (e: any) { if (signal.aborted) { h.flush(); post({ type: 'paused', id: m.id, have }); return; } throw new Fail('network', String(e?.message ?? e)); }
      if (res.status === 401) throw new Fail('auth', 'unauthorized');
      if (res.status === 429) throw new Fail('busy', 'server busy');
      if (res.status === 403 || res.status === 404 || res.status === 410) throw new Fail('gone', `gone (${res.status})`);
      if (res.status === 416) {
        // our offset is beyond the file: complete already, or the file changed -> from scratch
        const cr = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
        if (cr && Number(cr[1]) === have && have > 0) { total = have; break; }
        restart(); continue;
      }
      if (res.status === 200 && have > 0) { restart(); } // server ignored Range / If-Range mismatch: file changed
      else if (res.status === 206) {
        const cr = /^bytes (\d+)-\d+\/(\d+)/.exec(res.headers.get('content-range') ?? '');
        if (!cr || Number(cr[1]) !== have) { restart(); continue; }
        total = Number(cr[2]);
      } else if (!res.ok || !res.body) throw new Fail('network', `HTTP ${res.status}`);
      if (res.status === 200) total = Number(res.headers.get('content-length') ?? 0) || total;
      etag = res.headers.get('etag') ?? etag;

      const reader = res.body!.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const w = h.write(value, { at: have });
          if (w !== value.byteLength) throw new Fail('io', 'short write (storage full?)');
          have += w; sinceFlush += w;
          if (sinceFlush >= FLUSH_EVERY) { h.flush(); sinceFlush = 0; }
          const now = performance.now();
          if (now - lastPost > 250) { lastPost = now; post({ type: 'progress', id: m.id, have, total, etag }); }
        }
      } catch (e: any) {
        if (e instanceof Fail) throw e;
        if (signal.aborted) { h.flush(); post({ type: 'paused', id: m.id, have }); return; }
        h.flush(); post({ type: 'progress', id: m.id, have, total, etag });
        throw new Fail('network', String(e?.message ?? e));
      }
      break;
    }
    h.flush();
    if (total > 0 && have !== total) throw new Fail('size', `size mismatch (${have} of ${total})`);
    post({ type: 'done', id: m.id, bytes: have, etag });
  } finally {
    h.close();
    abort = null;
  }
}

ctx.onmessage = (ev: MessageEvent<StartMsg | { cmd: 'pause' }>) => {
  const m = ev.data;
  if (m.cmd === 'pause') { abort?.abort(); return; }
  if (abort) return; // one at a time
  run(m).catch((e: any) => {
    if (e instanceof Fail) post({ type: 'error', id: m.id, code: e.code, message: e.message });
    else post({ type: 'error', id: m.id, code: e?.name === 'NoModificationAllowedError' ? 'io' : 'network', message: String(e?.message ?? e) });
  });
};
