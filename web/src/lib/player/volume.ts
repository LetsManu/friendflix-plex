/** saved volume (0..1) from localStorage text; null when absent or invalid */
export function parseVolume(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}
export const stepVolume = (v: number, delta: number) => Math.round(Math.max(0, Math.min(1, v + delta)) * 100) / 100;
