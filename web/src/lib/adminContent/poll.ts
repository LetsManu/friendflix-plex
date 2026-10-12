/** Interval that skips ticks while the tab is hidden and runs once when it becomes visible again; returns the stop function. */
export function poll(fn: () => unknown, ms: number): () => void {
  const tick = () => { if (typeof document === 'undefined' || document.visibilityState === 'visible') void fn(); };
  const iv = setInterval(tick, ms);
  const vis = () => { if (document.visibilityState === 'visible') void fn(); };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', vis);
  return () => {
    clearInterval(iv);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', vis);
  };
}
