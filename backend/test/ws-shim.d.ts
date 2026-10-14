// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal typing for the `ws` client used in tests (no @types/ws installed).
declare module 'ws' {
  export default class WebSocket {
    constructor(url: string, options?: { headers?: Record<string, string> });
    readonly readyState: number;
    on(event: 'open', cb: () => void): this;
    on(event: 'close', cb: (code: number) => void): this;
    on(event: 'message', cb: (data: Buffer) => void): this;
    on(event: 'error', cb: (err: Error) => void): this;
    on(event: string, cb: (...args: any[]) => void): this;
    send(data: string | Buffer): void;
    close(code?: number): void;
    terminate(): void;
  }
}
