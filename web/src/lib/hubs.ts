// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Block 15: brand hub shapes shared by the home tiles, the hub page and the admin page. */
export interface Hub {
  id: string;
  name: string;
  source: 'studio' | 'collection' | 'tag' | 'genre';
  /** #rrggbb */
  accent?: string;
  /** Jellyfin image of a title / collection chosen by the admin; absent = generated gradient */
  imageUrl?: string;
}

function hue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

/** Tile background without any artwork: the accent colour (or a hue derived from the name) fading into dark. Never a bundled logo. */
export function hubGradient(h: Pick<Hub, 'name' | 'accent'>): string {
  if (h.accent) return `linear-gradient(135deg, ${h.accent}, color-mix(in srgb, ${h.accent} 22%, #0a0d10))`;
  const a = hue(h.name);
  return `linear-gradient(135deg, hsl(${a} 58% 36%), hsl(${(a + 40) % 360} 55% 12%))`;
}

/** glow colour of the hover/focus state */
export const hubGlow = (h: Pick<Hub, 'name' | 'accent'>): string => h.accent ?? `hsl(${hue(h.name)} 70% 55%)`;
