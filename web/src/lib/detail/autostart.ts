import { tr } from '#lib/i18n';

/**
 * Detail view "Vorschau startet Titel automatisch": once the hero preview has run long enough (it ended, or ~25 s),
 * a 5 s countdown starts the title (resume point / next-up episode). Never on touch/phones, on TV, in a hidden tab,
 * without a playable target, after the viewer cancelled, or when the pref is off (missing pref = on).
 * It must never interrupt active use: no arming while a popover is open or a text field has focus, only after the
 * AUTOMATIC preview (not a trailer the viewer started), and any interaction with the view cancels it for good.
 */
export const AUTOSTART_AFTER_S = 25;
export const AUTOSTART_COUNTDOWN_S = 5;

export interface AutoStartEnv {
  pref: boolean | undefined;
  touch: boolean;
  tv: boolean;
  hidden: boolean;
  reducedMotion: boolean;
  /** the preview is actually playing (or just ended) */
  previewing: boolean;
  /** a /watch target exists */
  hasTarget: boolean;
  cancelled: boolean;
  /** a MoreActions / RatingButton popover is open */
  popoverOpen?: boolean;
  /** an input/textarea/select/contenteditable has focus */
  typing?: boolean;
  /** the viewer explicitly started the trailer ("Trailer abspielen"): autostart only follows the automatic preview */
  userStartedPreview?: boolean;
}

export function autoStartAllowed(e: AutoStartEnv): boolean {
  return e.pref !== false && !e.touch && !e.tv && !e.hidden && !e.reducedMotion && e.previewing && e.hasTarget && !e.cancelled
    && !e.popoverOpen && !e.typing && !e.userStartedPreview;
}

/**
 * Does this DOM event inside the detail view count as "active use" (cancels autostart permanently for the view)?
 * Events on the countdown overlay itself never do (its "Abbrechen" button cancels explicitly). `focusin` only counts
 * while the countdown runs: the dialog's initial autofocus is not use, focus moved by the viewer during the countdown is.
 */
export function interactionCancels(type: string, onOverlay: boolean, counting: boolean): boolean {
  if (onOverlay) return false;
  if (type === 'focusin') return counting;
  return type === 'pointerdown' || type === 'keydown' || type === 'wheel';
}

/** the focused element takes text input (typing must never be interrupted by a navigation) */
export function isTextEntry(el: { tagName?: string; isContentEditable?: boolean; type?: string } | null | undefined): boolean {
  if (!el?.tagName) return false;
  const t = el.tagName.toUpperCase();
  if (t === 'TEXTAREA' || t === 'SELECT') return true;
  if (t === 'INPUT') return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes((el.type ?? 'text').toLowerCase());
  return Boolean(el.isContentEditable);
}

/** the preview ran long enough: ended, or reached AUTOSTART_AFTER_S */
export const previewDone = (ended: boolean, time: number) => ended || (Number.isFinite(time) && time >= AUTOSTART_AFTER_S);

/** "Folge startet in 5 …" / "Film startet in 5 …" */
export function countdownLabel(kind: 'episode' | 'movie', left: number): string {
  const n = Math.max(0, Math.ceil(left));
  return tr(kind === 'episode' ? 'detail.autostart.episode' : 'detail.autostart.movie', { n });
}
