// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autofocus, dialogKeys } from './actions';

/** focusable double; `doc.activeElement` follows focus() */
class Ctl {
  constructor(public name: string) {}
  focus = vi.fn(() => { doc.activeElement = this; });
  select = vi.fn();
}
class Input extends Ctl {}
let doc: { activeElement: unknown };

/** dialog node double holding a list of focusable controls */
function dialog(controls: Ctl[]) {
  const listeners = new Map<string, (e: KeyboardEvent) => void>();
  const node = {
    querySelectorAll: () => controls,
    querySelector: () => controls[0] ?? null,
    contains: (x: unknown) => controls.includes(x as Ctl),
    addEventListener: (t: string, f: (e: KeyboardEvent) => void) => listeners.set(t, f),
    removeEventListener: (t: string) => listeners.delete(t),
  };
  const press = (key: string, shiftKey = false) => {
    const e = { key, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    listeners.get('keydown')?.(e as unknown as KeyboardEvent);
    return e;
  };
  return { node: node as unknown as HTMLElement, press, listeners };
}

beforeEach(() => {
  doc = { activeElement: null };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('HTMLInputElement', Input);
});
afterEach(() => vi.unstubAllGlobals());

describe('autofocus', () => {
  it('focuses after the current task and selects the text of inputs', async () => {
    const input = new Input('q');
    autofocus(input as unknown as HTMLElement);
    expect(input.focus).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(input.focus).toHaveBeenCalled();
    expect(input.select).toHaveBeenCalled();
    const btn = new Ctl('b');
    autofocus(btn as unknown as HTMLElement);
    await Promise.resolve();
    expect(btn.focus).toHaveBeenCalled();
    expect(btn.select).not.toHaveBeenCalled();
  });
});

describe('dialogKeys', () => {
  it('Escape closes the dialog and is not passed on', () => {
    const close = vi.fn();
    const d = dialog([new Ctl('a')]);
    dialogKeys(d.node, { close });
    const e = d.press('Escape');
    expect(close).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
  });

  it('Tab wraps from the last control to the first, Shift+Tab from the first to the last', () => {
    const [a, b, c] = [new Ctl('a'), new Ctl('b'), new Ctl('c')];
    const d = dialog([a, b, c]);
    dialogKeys(d.node, { close: () => undefined });
    c.focus();
    expect(d.press('Tab').preventDefault).toHaveBeenCalled();
    expect(doc.activeElement).toBe(a);
    d.press('Tab', true);
    expect(doc.activeElement).toBe(c);
    b.focus();
    const mid = d.press('Tab'); // in the middle: the browser moves the focus itself
    expect(mid.preventDefault).not.toHaveBeenCalled();
    expect(doc.activeElement).toBe(b);
  });

  it('Tab pulls a focus that escaped back to the first control; without controls Tab does nothing', () => {
    const a = new Ctl('a');
    const d = dialog([a]);
    dialogKeys(d.node, { close: () => undefined });
    doc.activeElement = new Ctl('outside');
    d.press('Tab');
    expect(doc.activeElement).toBe(a);
    const empty = dialog([]);
    dialogKeys(empty.node, { close: () => undefined });
    expect(empty.press('Tab').preventDefault).toHaveBeenCalled();
    expect(empty.press('a').preventDefault).not.toHaveBeenCalled();
  });

  it('focusFirst, update() swaps the close handler, destroy() removes the listener', async () => {
    const a = new Ctl('a');
    const d = dialog([a]);
    const first = vi.fn();
    const second = vi.fn();
    const action = dialogKeys(d.node, { close: first, focusFirst: true });
    await Promise.resolve();
    expect(a.focus).toHaveBeenCalled();
    action.update({ close: second });
    d.press('Escape');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    action.destroy();
    expect(d.listeners.size).toBe(0);
  });
});
