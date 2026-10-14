// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Test double of the Origin Private File System (directory/file handles and worker sync access handles).
// Test infrastructure only: excluded from coverage (see vitest.config.ts).

const domError = (name: string, message = name) => Object.assign(new Error(message), { name });

/** worker-only sync access handle over a FakeFile */
function syncHandle(f: FakeFile) {
  return {
    getSize: () => f.data.length,
    truncate(n: number) { const d = new Uint8Array(n); d.set(f.data.subarray(0, n)); f.data = d; },
    write(buf: Uint8Array, opts: { at: number }) {
      const n = Math.max(0, Math.min(buf.byteLength, FakeFile.writeBudget));
      FakeFile.writeBudget -= n;
      const end = opts.at + n;
      if (end > f.data.length) { const d = new Uint8Array(end); d.set(f.data); f.data = d; }
      f.data.set(buf.subarray(0, n), opts.at);
      return n;
    },
    flush() { /* in memory */ },
    close() { f.open = false; },
  };
}

export class FakeFile {
  kind = 'file' as const;
  data = new Uint8Array(0);
  open = false;
  /** bytes a write may still store before it comes back short (storage full); Infinity = no limit */
  static writeBudget = Infinity;
  constructor(public name: string) {}
  async getFile(): Promise<File> { return new File([this.data.slice()], this.name); }
  async createSyncAccessHandle() {
    if (this.open) throw domError('NoModificationAllowedError', 'file is locked');
    this.open = true;
    return syncHandle(this);
  }
}

export class FakeDir {
  kind = 'directory' as const;
  entries = new Map<string, FakeDir | FakeFile>();
  constructor(public name = '') {}
  async getDirectoryHandle(name: string, opts: { create?: boolean } = {}): Promise<FakeDir> {
    const e = this.entries.get(name);
    if (e instanceof FakeDir) return e;
    if (e) throw domError('TypeMismatchError');
    if (!opts.create) throw domError('NotFoundError', `${name} not found`);
    const d = new FakeDir(name);
    this.entries.set(name, d);
    return d;
  }
  async getFileHandle(name: string, opts: { create?: boolean } = {}): Promise<FakeFile> {
    const e = this.entries.get(name);
    if (e instanceof FakeFile) return e;
    if (e) throw domError('TypeMismatchError');
    if (!opts.create) throw domError('NotFoundError', `${name} not found`);
    const f = new FakeFile(name);
    this.entries.set(name, f);
    return f;
  }
  async removeEntry(name: string, _opts?: { recursive?: boolean }): Promise<void> {
    if (!this.entries.delete(name)) throw domError('NotFoundError', `${name} not found`);
  }
  async *keys(): AsyncGenerator<string> { for (const k of [...this.entries.keys()]) yield k; }
  /** test helper: path lookup ('ff-dl/<id>/video.mp4') */
  find(path: string): FakeDir | FakeFile | undefined {
    const [head, ...rest] = path.split('/');
    const e = this.entries.get(head!);
    if (!rest.length) return e;
    return e instanceof FakeDir ? e.find(rest.join('/')) : undefined;
  }
}
