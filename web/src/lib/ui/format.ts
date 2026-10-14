// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { intlLocale } from '#lib/i18n';

/** "1,2 GB" / "340 MB" in the UI language (binary multiples, unit names from Intl). */
export function fmtBytes(bytes: number | null | undefined): string {
  const b = Math.max(0, Number(bytes) || 0);
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
  let i = 0, v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return new Intl.NumberFormat(intlLocale(), { style: 'unit', unit: units[i], unitDisplay: 'short', maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 }).format(v);
}
