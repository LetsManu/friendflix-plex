// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dominantColor } from './tint';

/** 24x24 RGBA pixels the fake canvas returns */
let pixels: Uint8ClampedArray;
let noContext = false;
let throwOnRead = false;

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(v: string) { queueMicrotask(() => (v.includes('broken') ? this.onerror?.() : this.onload?.())); }
}
const fill = (n: number, rgb: [number, number, number]) => { for (let i = 0; i < n; i++) pixels.set([...rgb, 255], i * 4); };

beforeEach(() => {
  pixels = new Uint8ClampedArray(24 * 24 * 4);
  noContext = false;
  throwOnRead = false;
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => (noContext ? null : {
        drawImage: () => undefined,
        getImageData: () => { if (throwOnRead) throw new DOMException('tainted', 'SecurityError'); return { data: pixels }; },
      }),
    }),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('dominantColor', () => {
  it('a uniform image yields its colour', async () => {
    fill(576, [200, 40, 60]);
    expect(await dominantColor('/poster.jpg')).toEqual([200, 40, 60]);
  });

  it('prefers colourful pixels over black and white ones', async () => {
    fill(576, [0, 0, 0]); // mostly black ...
    fill(150, [30, 120, 220]); // ... with a quarter of saturated blue
    const [r, g, b] = (await dominantColor('/poster.jpg'))!;
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(110); // far above the plain average (~57)
    expect(g).toBeGreaterThan(r);
  });

  it('null when the image fails to load, the canvas has no 2D context or reading pixels is refused', async () => {
    expect(await dominantColor('/broken.jpg')).toBeNull();
    noContext = true;
    expect(await dominantColor('/poster.jpg')).toBeNull();
    noContext = false;
    throwOnRead = true; // cross-origin image taints the canvas
    expect(await dominantColor('/poster.jpg')).toBeNull();
  });
});
