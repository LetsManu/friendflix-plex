/** Mouse wheel / trackpad -> volume steps: deltas are normalised to pixels and add up; one step per 100 px, idle for 200 ms starts over. */
export const WHEEL_STEP_PX = 100;
export const WHEEL_IDLE_MS = 200;
export class WheelAccumulator {
  private acc = 0;
  private last = -Infinity;
  /** returns the whole steps now due (positive = wheel down); deltaMode 1 = lines, 2 = pages */
  add(deltaY: number, deltaMode: number, now: number, pageHeight = 800): number {
    if (now - this.last > WHEEL_IDLE_MS) this.acc = 0;
    this.last = now;
    this.acc += deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1);
    const n = Math.trunc(this.acc / WHEEL_STEP_PX);
    this.acc -= n * WHEEL_STEP_PX;
    return n;
  }
}
