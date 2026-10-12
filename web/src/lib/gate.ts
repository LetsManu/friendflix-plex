/**
 * Profile gate ("Wer schaut gerade?") and the early-render hint of the app shell.
 *
 * Accounts with more than one profile see the gate once per browser session (new tab/window = new session),
 * like the big streaming apps. The pick is remembered in sessionStorage by /profiles.
 */
export const PICKED_KEY = 'ff-profile-picked';
/** localStorage: flags of the last /api/me answer (no names), lets the layout render the page before /api/me returns */
export const HINT_KEY = 'ff-boot-hint';
/** sessionStorage: profile id this tab runs with (sent as x-ff-profile by early requests) */
export const ACTIVE_KEY = 'ff-active-profile';
/** sessionStorage flag lib/api.ts sets before reloading after a profile switch in another tab */
const RELOAD_KEY = 'ff_profile_reload';

export interface GateMe { profileRequired?: boolean; profileCount?: number; profileChosen?: boolean; tv?: boolean }
export interface BootHint { approved: boolean; multi: boolean; tv: boolean; /** single-profile accounts only: that profile never changes */ profile?: string; /** UI language of the last answer: an early-rendered page waits until it is active */ lang?: string }

/** paths that never show the per-session gate (the profile page itself, the phone remote control) */
const NO_SESSION_GATE = /^\/(profiles|remote)(\/|$)/;

/** true when the layout must send the user to /profiles before showing `path` */
export function needsProfileGate(me: GateMe, path: string, sessionPicked: boolean): boolean {
  if (path === '/profiles') return false;
  const multi = (me.profileCount ?? 0) > 1;
  if (me.profileRequired || (multi && !me.profileChosen)) return true; // server: no profile chosen for this login yet
  // once per browser session; televisions (paired, shared screen) and the remote control keep their profile
  return multi && !sessionPicked && !me.tv && !NO_SESSION_GATE.test(path);
}

/** `/profiles?next=…` for the current location (deep links continue after the pick) */
export const gateHref = (pathAndSearch: string) => `/profiles?next=${encodeURIComponent(pathAndSearch)}`;

export function hintOf(me: GateMe & { deviceApproved?: boolean; profile?: { id: string } | null; language?: string }): BootHint {
  const multi = (me.profileCount ?? 0) > 1;
  return { approved: Boolean(me.deviceApproved), multi, tv: Boolean(me.tv), ...(!multi && me.profile?.id ? { profile: me.profile.id } : {}), ...(me.language ? { lang: me.language } : {}) };
}

/** profile id early requests of this tab use: the one this tab ran with, else the only profile of a single-profile account */
export const earlyProfile = (h: BootHint | null, tabProfile: string | null): string | null => tabProfile ?? (h && !h.multi ? h.profile ?? null : null);

export function parseHint(raw: string | null | undefined): BootHint | null {
  if (!raw) return null;
  try {
    const h = JSON.parse(raw);
    if (!(h && typeof h === 'object' && typeof h.approved === 'boolean' && typeof h.multi === 'boolean' && typeof h.tv === 'boolean')) return null;
    return { approved: h.approved, multi: h.multi, tv: h.tv, ...(typeof h.profile === 'string' && h.profile ? { profile: h.profile } : {}), ...(typeof h.lang === 'string' && /^[a-z]{2}$/.test(h.lang) ? { lang: h.lang } : {}) };
  } catch { return null; }
}

/**
 * The page may render (and start its own requests) while /api/me is still pending when the last answer said:
 * approved device, no TV, and no gate due in this session. Wrong guesses are corrected as soon as /api/me arrives.
 */
export const canRenderEarly = (h: BootHint | null, sessionPicked: boolean, path: string, activeProfile: string | null = 'x', reloading = false): boolean =>
  Boolean(h && h.approved && !h.tv && !(h.multi && !sessionPicked) && path !== '/profiles' && activeProfile && !reloading);

const ss = () => { try { return sessionStorage; } catch { return null; } };
const ls = () => { try { return localStorage; } catch { return null; } };
export function readPicked(): boolean { try { return ss()?.getItem(PICKED_KEY) === '1'; } catch { return false; } }
/** the gate was answered in this tab; `profileId` is the profile it switched to */
export function markPicked(profileId?: string): void { try { ss()?.setItem(PICKED_KEY, '1'); if (profileId) ss()?.setItem(ACTIVE_KEY, profileId); } catch { /* private mode */ } }
export function readActive(): string | null { try { return ss()?.getItem(ACTIVE_KEY) || null; } catch { return null; } }
export function writeActive(id: string | null | undefined): void { try { if (id) ss()?.setItem(ACTIVE_KEY, id); else ss()?.removeItem(ACTIVE_KEY); } catch { /* ignore */ } }
/** /api/me answered after a profile-switch reload: the reload guard has done its job (early render is allowed again) */
export function clearReloadFlag(): void { try { ss()?.removeItem(RELOAD_KEY); } catch { /* ignore */ } }
export function readReloading(): boolean { try { return ss()?.getItem(RELOAD_KEY) === '1'; } catch { return false; } }
export function readHint(): BootHint | null { try { return parseHint(ls()?.getItem(HINT_KEY)); } catch { return null; } }
export function writeHint(h: BootHint): void { try { ls()?.setItem(HINT_KEY, JSON.stringify(h)); } catch { /* ignore */ } }
export function clearHint(): void { try { ls()?.removeItem(HINT_KEY); ss()?.removeItem(PICKED_KEY); ss()?.removeItem(ACTIVE_KEY); } catch { /* ignore */ } }
