/**
 * D-pad navigation for TV browsers: the arrow keys move the focus to the nearest focusable element in that
 * direction (geometric search, no hand-written focus maps), "Back" keys are recognised across TV platforms.
 */
type Dir = 'left' | 'right' | 'up' | 'down';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const DIRS: Record<string, Dir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
/** Back on remotes: Tizen 10009, webOS 461, Android/Fire TV 4 (and 166 on some), the browser/keyboard names and Backspace */
const BACK_CODES = new Set([10009, 461, 4, 166]);
const BACK_KEYS = new Set(['BrowserBack', 'GoBack', 'XF86Back', 'Backspace']);

export const isEditable = (el: Element | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit'].includes((el as HTMLInputElement).type);
};
const isSlider = (el: Element | null) => el instanceof HTMLElement && (el.getAttribute('role') === 'slider' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'range'));

/** "Back" pressed on a TV remote (Backspace only counts outside of text fields) */
export function isBackKey(e: KeyboardEvent): boolean {
  if (BACK_CODES.has(e.keyCode)) return true;
  if (e.key === 'Backspace') return !isEditable(e.target as Element);
  return BACK_KEYS.has(e.key);
}

function usable(el: HTMLElement): boolean {
  if (el.matches('.skip') || el.closest('[inert], [hidden], [data-nav-skip]')) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cv = (el as HTMLElement & { checkVisibility?: (o: object) => boolean }).checkVisibility;
  return typeof cv === 'function' ? cv.call(el, { checkVisibilityCSS: true }) : true;
}

const gap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, b0 - a1, a0 - b1); // 0 when the ranges overlap

/** lower is better; Infinity = not a candidate for this direction */
function score(a: DOMRect, b: DOMRect, dir: Dir): number {
  const horizontal = dir === 'left' || dir === 'right';
  const ac = horizontal ? a.left + a.width / 2 : a.top + a.height / 2, bc = horizontal ? b.left + b.width / 2 : b.top + b.height / 2;
  if (dir === 'right' || dir === 'down' ? bc <= ac + 1 : bc >= ac - 1) return Infinity; // wrong side
  const along = horizontal
    ? (dir === 'right' ? b.left - a.right : a.left - b.right)
    : (dir === 'down' ? b.top - a.bottom : a.top - b.bottom);
  const across = horizontal ? gap(a.top, a.bottom, b.top, b.bottom) : gap(a.left, a.right, b.left, b.right);
  // left/right stay in their row (a card at the end of a row does not jump into the next row);
  // up/down may land on anything below/above, preferring the closest and best aligned element
  if (horizontal && across > 0) return Infinity;
  const mis = horizontal ? Math.abs((b.top + b.height / 2) - (a.top + a.height / 2)) : Math.abs((b.left + b.width / 2) - (a.left + a.width / 2));
  return Math.max(0, along) + across * 2 + mis * (horizontal ? 0.3 : 0.5);
}

const reduce = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function focusEl(el: HTMLElement) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: reduce() ? 'auto' : 'smooth' });
}

/** the first sensible element inside `root`: [data-autofocus] wins, otherwise the first visible focusable (`scroll`: bring it to the centre) */
export function focusFirst(root: ParentNode | null, scroll = true): boolean {
  if (!root) return false;
  // links and buttons first: landing in a text field would pop up the TV's on-screen keyboard
  const pick = root.querySelector<HTMLElement>('[data-autofocus]') ?? [...root.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')].find(usable) ?? [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].find(usable);
  if (!pick) return false;
  if (scroll) focusEl(pick); else pick.focus({ preventScroll: true });
  return true;
}

function scopeOf(active: HTMLElement | null): ParentNode {
  return active?.closest('[data-scope]') ?? document.querySelector('[aria-modal="true"]') ?? document.body;
}

export function move(dir: Dir, retried = false): boolean {
  const cur = document.activeElement;
  const active = cur instanceof HTMLElement && cur !== document.body && cur !== document.documentElement ? cur : null;
  const scope = scopeOf(active);
  if (!active || !scope.contains(active) || !usable(active)) return focusFirst(document.querySelector('main') ?? scope);
  const from = active.getBoundingClientRect();
  let best: HTMLElement | null = null, bestScore = Infinity;
  for (const el of scope.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (el === active || !usable(el)) continue;
    const s = score(from, el.getBoundingClientRect(), dir);
    if (s < bestScore) { bestScore = s; best = el; }
  }
  if (best) { focusEl(best); return true; }
  // nothing below yet: rows further down load lazily when scrolled into view -> scroll and look once more
  if (dir === 'down' && !retried && window.scrollY + window.innerHeight < document.documentElement.scrollHeight - 8) {
    window.scrollBy({ top: window.innerHeight * 0.7, behavior: 'auto' });
    setTimeout(() => move('down', true), 350);
    return true;
  }
  return false;
}

/**
 * Starts the key handler (capture phase, so it also works inside widgets that stop propagation).
 * `enabled` lets the page opt out (the player handles its own keys unless a control has the focus).
 */
export function startSpatial(enabled: () => boolean): () => void {
  const onKey = (e: KeyboardEvent) => {
    const dir = DIRS[e.key];
    if (!dir || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !enabled()) return;
    const active = document.activeElement;
    if ((dir === 'left' || dir === 'right') && (isEditable(active) || isSlider(active))) return; // caret / seek keep their arrows
    e.preventDefault(); // the focus moves, the page does not scroll by itself
    if (move(dir)) e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
