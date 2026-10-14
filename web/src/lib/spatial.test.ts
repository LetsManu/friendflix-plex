// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusFirst, isBackKey, isEditable, move, startSpatial, usable } from './spatial';

/**
 * A tiny DOM double, just enough for the geometric focus search: elements with a tag, attributes, a box and
 * children; a selector matcher for the simple selectors spatial.ts uses (tag, .class, [attr], [attr="v"], :not(...)).
 */
class El {
  tagName: string;
  attrs = new Map<string, string>();
  classes = new Set<string>();
  children: El[] = [];
  parent: El | null = null;
  rect = { left: 0, top: 0, width: 100, height: 50 };
  isContentEditable = false;
  type = '';
  listeners = new Map<string, Array<(e: Event) => void>>();
  checkVisibility?: () => boolean;
  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tagName = tag.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') v.split(' ').forEach((c) => this.classes.add(c));
      else this.attrs.set(k, v);
    }
    if (attrs.type) this.type = attrs.type;
  }
  add(...kids: El[]) { for (const k of kids) { k.parent = this; this.children.push(k); } return this; }
  at(left: number, top: number, width = 100, height = 50) { this.rect = { left, top, width, height }; return this; }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  getBoundingClientRect() { const r = this.rect; return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top } as DOMRect; }
  matches(sel: string): boolean { return sel.split(',').some((s) => matchOne(this, s.trim())); }
  closest(sel: string): El | null { return this.matches(sel) ? this : (this.parent?.closest(sel) ?? null); }
  contains(o: El | null): boolean { for (let e = o; e; e = e.parent) if (e === this) return true; return false; }
  *walk(): Generator<El> { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelectorAll(sel: string) { return [...this.walk()].filter((e) => e.matches(sel)); }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
  focus = vi.fn(() => { doc.activeElement = this; });
  scrollIntoView = vi.fn();
  addEventListener(t: string, fn: (e: Event) => void) { this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]); }
  dispatchEvent(e: Event): boolean {
    for (const fn of this.listeners.get(e.type) ?? []) fn(e);
    if (this.parent) return this.parent.dispatchEvent(e);
    return !e.defaultPrevented;
  }
}
function matchOne(el: El, sel: string): boolean {
  const re = /^([a-z]+)?((?:\.[\w-]+|\[[^\]]+\]|:not\(\[[^\]]+\]\))*)$/i;
  const m = re.exec(sel);
  if (!m) throw new Error(`selector not supported by the test DOM: ${sel}`);
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const part of m[2]!.match(/\.[\w-]+|\[[^\]]+\]|:not\(\[[^\]]+\]\)/g) ?? []) {
    if (part.startsWith('.')) { if (!el.classes.has(part.slice(1))) return false; continue; }
    const neg = part.startsWith(':not');
    const [, k, v] = /\[([\w-]+)(?:="([^"]*)")?\]/.exec(part)!;
    const has = el.attrs.has(k!) && (v === undefined || el.attrs.get(k!) === v);
    if (has === neg) return false;
  }
  return true;
}

let doc: { activeElement: El | null; body: El; documentElement: El & { scrollHeight: number }; querySelector: (s: string) => El | null };
let win: { scrollY: number; innerHeight: number; scrollBy: ReturnType<typeof vi.fn>; listeners: Map<string, (e: unknown) => void>; addEventListener: (t: string, f: (e: unknown) => void) => void; removeEventListener: (t: string) => void };

beforeEach(() => {
  const body = new El('body');
  const html = Object.assign(new El('html'), { scrollHeight: 1000 });
  html.add(body);
  doc = { activeElement: body, body, documentElement: html, querySelector: (s) => html.querySelector(s) };
  win = { scrollY: 0, innerHeight: 800, scrollBy: vi.fn(), listeners: new Map(), addEventListener: (t, f) => win.listeners.set(t, f), removeEventListener: (t) => win.listeners.delete(t) };
  vi.stubGlobal('HTMLElement', El);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** two rows of three buttons (100x50, 20 px gaps) inside <main> */
function grid() {
  const main = new El('main');
  const b = (n: string, x: number, y: number) => new El('button', { id: n }).at(x, y);
  const row1 = [b('a', 0, 0), b('b', 120, 0), b('c', 240, 0)];
  const row2 = [b('d', 0, 100), b('e', 120, 100), b('f', 240, 100)];
  main.add(...row1, ...row2);
  doc.body.add(main);
  return { main, a: row1[0]!, b: row1[1]!, c: row1[2]!, d: row2[0]!, e: row2[1]!, f: row2[2]! };
}
const id = () => doc.activeElement?.getAttribute('id');

describe('key classification', () => {
  it('recognises Back on Tizen, webOS, Android and keyboards; Backspace only outside text fields', () => {
    const k = (key: string, keyCode = 0, target: unknown = null) => ({ key, keyCode, target }) as unknown as KeyboardEvent;
    expect(isBackKey(k('', 10009))).toBe(true);
    expect(isBackKey(k('', 461))).toBe(true);
    expect(isBackKey(k('GoBack'))).toBe(true);
    expect(isBackKey(k('Backspace', 8, new El('div')))).toBe(true);
    expect(isBackKey(k('Backspace', 8, new El('input', { type: 'text' })))).toBe(false);
    expect(isBackKey(k('Escape', 27))).toBe(false);
  });

  it('isEditable: text inputs, textareas and contenteditable, not checkboxes or buttons', () => {
    expect(isEditable(new El('input', { type: 'search' }) as unknown as Element)).toBe(true);
    expect(isEditable(new El('textarea') as unknown as Element)).toBe(true);
    expect(isEditable(Object.assign(new El('div'), { isContentEditable: true }) as unknown as Element)).toBe(true);
    expect(isEditable(new El('input', { type: 'checkbox' }) as unknown as Element)).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});

describe('usable', () => {
  it('skips tiny, hidden, inert, skip-link and CSS-invisible elements', () => {
    const ok = new El('button');
    expect(usable(ok as unknown as HTMLElement)).toBe(true);
    expect(usable(new El('button').at(0, 0, 1, 50) as unknown as HTMLElement)).toBe(false);
    expect(usable(new El('a', { class: 'skip', href: '#main' }) as unknown as HTMLElement)).toBe(false);
    const inert = new El('div', { inert: '' }).add(new El('button'));
    expect(usable(inert.children[0] as unknown as HTMLElement)).toBe(false);
    expect(usable(Object.assign(new El('button'), { checkVisibility: () => false }) as unknown as HTMLElement)).toBe(false);
  });
});

describe('move', () => {
  it('without a usable focus it focuses the first button in <main>, preferring [data-autofocus]', () => {
    const g = grid();
    expect(move('down')).toBe(true);
    expect(id()).toBe('a');
    g.e.attrs.set('data-autofocus', '');
    doc.activeElement = doc.body;
    move('right');
    expect(id()).toBe('e');
    expect(g.e.scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'center', behavior: 'smooth' });
  });

  it('left/right stay in the row and stop at its end', () => {
    const g = grid();
    g.a.focus();
    expect(move('right')).toBe(true);
    expect(id()).toBe('b');
    move('right');
    expect(id()).toBe('c');
    expect(move('right')).toBe(false); // no jump into the next row
    expect(id()).toBe('c');
    move('left');
    expect(id()).toBe('b');
  });

  it('up/down go to the closest, best aligned element', () => {
    const g = grid();
    g.b.focus();
    move('down');
    expect(id()).toBe('e');
    move('up');
    expect(id()).toBe('b');
  });

  it('honours reduced motion when scrolling the new focus into view', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const g = grid();
    g.a.focus();
    move('right');
    expect(g.b.scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'center', behavior: 'auto' });
  });

  it('stays inside an open modal', () => {
    grid();
    const dialog = new El('div', { 'aria-modal': 'true' }).add(new El('button', { id: 'ok' }).at(0, 500), new El('button', { id: 'cancel' }).at(120, 500));
    doc.body.add(dialog);
    (dialog.children[0] as El).focus();
    move('right');
    expect(id()).toBe('cancel');
    expect(move('up')).toBe(false); // the grid behind the modal is not reachable
  });

  it('a [data-scope] container keeps the search inside it', () => {
    const g = grid();
    const scoped = new El('div', { 'data-scope': '' }).add(new El('button', { id: 's1' }).at(0, 300), new El('button', { id: 's2' }).at(0, 400));
    g.main.add(scoped);
    (scoped.children[1] as El).focus();
    move('up');
    expect(id()).toBe('s1');
    expect(move('up')).toBe(false); // row 2 of the grid is outside the scope
  });

  it('a widget can take over one step by cancelling the ff-nav event', () => {
    const g = grid();
    g.a.focus();
    g.main.addEventListener('ff-nav', (e) => { if ((e as CustomEvent).detail.dir === 'down') e.preventDefault(); });
    expect(move('down')).toBe(true);
    expect(id()).toBe('a');
    move('right');
    expect(id()).toBe('b');
  });

  it('at the bottom of the loaded content it scrolls down once and looks again (lazy rows)', () => {
    vi.useFakeTimers();
    const g = grid();
    doc.documentElement.scrollHeight = 3000;
    g.e.focus();
    expect(move('down')).toBe(true);
    expect(win.scrollBy).toHaveBeenCalledWith({ top: 560, behavior: 'auto' });
    const late = new El('button', { id: 'late' }).at(120, 900);
    g.main.add(late);
    vi.advanceTimersByTime(350);
    expect(id()).toBe('late');
    // already at the end of the page: nothing to load
    win.scrollY = 200;
    doc.documentElement.scrollHeight = 1000;
    expect(move('down')).toBe(false);
  });
});

describe('focusFirst', () => {
  it('prefers links/buttons over text fields and can skip scrolling', () => {
    const root = new El('div').add(new El('input', { type: 'text', id: 'q' }), new El('a', { href: '/x', id: 'link' }));
    expect(focusFirst(root as unknown as ParentNode, false)).toBe(true);
    expect(id()).toBe('link');
    expect((root.children[1] as El).scrollIntoView).not.toHaveBeenCalled();
    const onlyInput = new El('div').add(new El('input', { type: 'text', id: 'q2' }));
    focusFirst(onlyInput as unknown as ParentNode);
    expect(id()).toBe('q2');
    expect(focusFirst(new El('div') as unknown as ParentNode)).toBe(false);
    expect(focusFirst(null)).toBe(false);
  });
});

describe('startSpatial', () => {
  const key = (k: string, extra: Partial<KeyboardEvent> = {}) => {
    const e = { key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
    win.listeners.get('keydown')!(e);
    return e;
  };

  it('moves the focus on arrow keys and swallows handled keys; stops when disposed', () => {
    const g = grid();
    g.a.focus();
    let on = true;
    const stop = startSpatial(() => on);
    const e = key('ArrowRight');
    expect(id()).toBe('b');
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
    key('ArrowRight', { shiftKey: true }); // modifiers are left alone
    key('Enter');
    on = false; // e.g. the player handles its own keys
    key('ArrowRight');
    expect(id()).toBe('b');
    stop();
    expect(win.listeners.has('keydown')).toBe(false);
  });

  it('left/right keep their meaning in text fields and sliders, up/down still move', () => {
    const main = new El('main');
    const input = new El('input', { type: 'text', id: 'in' }).at(0, 0);
    const slider = new El('div', { role: 'slider', tabindex: '0', id: 'sl' }).at(0, 100);
    const below = new El('button', { id: 'btn' }).at(0, 200);
    main.add(input, slider, below);
    doc.body.add(main);
    doc.documentElement.scrollHeight = 800; // the whole page is visible: no lazy-row scrolling
    startSpatial(() => true);
    input.focus();
    const e = key('ArrowLeft');
    expect(e.preventDefault).not.toHaveBeenCalled();
    key('ArrowDown');
    expect(id()).toBe('sl');
    key('ArrowRight');
    expect(id()).toBe('sl');
    const last = key('ArrowDown');
    expect(id()).toBe('btn');
    expect(last.stopPropagation).toHaveBeenCalled();
    const end = key('ArrowDown'); // nothing further: default prevented, but the event is passed on
    expect(end.preventDefault).toHaveBeenCalled();
    expect(end.stopPropagation).not.toHaveBeenCalled();
  });
});
