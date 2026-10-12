import { readable } from 'svelte/store';

/** Phone layout: same breakpoint as the old tab bar. */
export const MOBILE_QUERY = '(max-width: 720px)';

/** `true` on phone-sized viewports (reactive, SSR/test safe: false without matchMedia). */
export const mobile = readable(false, (set) => {
  if (typeof matchMedia === 'undefined') return;
  const mq = matchMedia(MOBILE_QUERY);
  const sync = () => set(mq.matches);
  sync();
  mq.addEventListener('change', sync);
  return () => mq.removeEventListener('change', sync);
});
