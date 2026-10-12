/** Profile avatars are a colour key; rendered as a rounded square with the initial. */
export const AVATARS: Array<[key: string, label: string, css: string]> = [
  ['red', 'Rot', 'linear-gradient(135deg, #ff3b52, #7a0a17)'],
  ['blue', 'Blau', 'linear-gradient(135deg, #3b82f6, #12347a)'],
  ['green', 'Grün', 'linear-gradient(135deg, #34d399, #0b5a3c)'],
  ['yellow', 'Gelb', 'linear-gradient(135deg, #facc15, #8a5a00)'],
  ['purple', 'Lila', 'linear-gradient(135deg, #a855f7, #471a7a)'],
  ['teal', 'Türkis', 'linear-gradient(135deg, #2dd4bf, #0b5560)'],
  ['orange', 'Orange', 'linear-gradient(135deg, #fb923c, #8a3300)'],
  ['pink', 'Rosa', 'linear-gradient(135deg, #f472b6, #7d1a52)'],
];
export const avatarBg = (key: string | undefined) => (AVATARS.find((a) => a[0] === key) ?? AVATARS[0])[2];
export const initial = (name: string | undefined) => (name ?? '?').trim().slice(0, 1).toUpperCase() || '?';
