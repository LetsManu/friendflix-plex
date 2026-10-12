/** Pure decision logic + storage helpers for the FriendFlix brand intro (see Intro.svelte, sonic.ts). */

export interface IntroSettings {
  /** show the intro at all */
  show: boolean;
  /** play the sonic logo */
  sound: boolean;
  /** the stored value explicitly turned the sound on (needed to play sound under prefers-reduced-motion) */
  soundExplicit: boolean;
}

export const DEFAULT_INTRO: IntroSettings = { show: true, sound: true, soundExplicit: false };
export const SESSION_KEY = 'ff-intro-seen';

/** Per-profile storage key; falls back to a global key when no profile is known. */
export const introKey = (profileId?: string | null) => (profileId ? `ff-intro:${profileId}` : 'ff-intro:global');

/** Parses a stored value; anything unreadable yields the defaults. */
export function parseIntroSettings(raw: string | null | undefined): IntroSettings {
  if (!raw) return { ...DEFAULT_INTRO };
  try {
    const o = JSON.parse(raw) as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') return { ...DEFAULT_INTRO };
    const sound = typeof o.sound === 'boolean' ? o.sound : DEFAULT_INTRO.sound;
    return { show: typeof o.show === 'boolean' ? o.show : DEFAULT_INTRO.show, sound, soundExplicit: o.sound === true };
  } catch { return { ...DEFAULT_INTRO }; }
}

export function loadIntroSettings(profileId?: string | null): IntroSettings {
  try { return parseIntroSettings(localStorage.getItem(introKey(profileId))); } catch { return { ...DEFAULT_INTRO }; }
}
export function saveIntroSettings(profileId: string | null | undefined, s: Pick<IntroSettings, 'show' | 'sound'>): void {
  try { localStorage.setItem(introKey(profileId), JSON.stringify({ show: s.show, sound: s.sound })); } catch { /* storage blocked */ }
}

export function readSessionSeen(): boolean {
  try { return sessionStorage.getItem(SESSION_KEY) === '1'; } catch { return false; }
}
export function markSessionSeen(): void {
  try { sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* storage blocked */ }
}

/** Routes that never get an intro: the player, watch parties, TV pairing and other public pages. */
export function isIntroFreeRoute(route: string): boolean {
  return /^\/(watch|party|tv|invite|offline)(\/|$)/.test(route);
}

export interface IntroContext {
  /** the "Intro beim Start zeigen" setting */
  setting: boolean;
  reducedMotion: boolean;
  /** current pathname */
  route: string;
  /** an intro already played in this browser session */
  sessionSeen: boolean;
  /** paired television / TV preview mode */
  tv: boolean;
  /** automatic cold-start intro (no user gesture). With reduced motion it is skipped; a user-triggered intro shows the calm fade instead. */
  cold?: boolean;
  /** the profile's calm mode (nothing moves by itself): the cold-start intro is skipped like with reduced motion */
  calm?: boolean;
}

export function shouldPlayIntro({ setting, reducedMotion, route, sessionSeen, tv, cold = false, calm = false }: IntroContext): boolean {
  if (!setting || tv || sessionSeen) return false;
  if (isIntroFreeRoute(route)) return false;
  if (cold && (reducedMotion || calm)) return false;
  return true;
}

/** Sound is only possible after a user gesture (never on cold start) and, with reduced motion, only if explicitly enabled. */
export function shouldPlayIntroSound(o: { sound: boolean; soundExplicit: boolean; reducedMotion: boolean; cold?: boolean }): boolean {
  if (!o.sound || o.cold) return false;
  return !o.reducedMotion || o.soundExplicit;
}
