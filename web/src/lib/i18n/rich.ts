/**
 * Minimal safe markup for translated sentences: only <b>…</b>, <kbd>…</kbd> and <a href="/internal">…</a>
 * (no nesting, no attributes besides an app-internal href). Everything else stays plain text, so a translation can never inject HTML.
 *
 * Interpolated values (titles from metadata, codes from the URL …) are never parsed as markup: <Rich key=… params=…>
 * translates with markers in place of the values, parses the markup of the translation, then puts the values into the
 * text parts (see richParts' `values`).
 */
export type RichPart = { kind: 'text' | 'b' | 'kbd'; text: string } | { kind: 'a'; text: string; href: string };

/** private-use characters marking an interpolated value: name */
const OPEN = '', CLOSE = '';
const MARK = /(\w+)/g;
/**
 * App-internal href: starts with a single "/" (not "//", not "/\" which browsers treat as "//"), no whitespace,
 * control characters, backslashes, quotes or markers anywhere (browsers drop tabs/newlines: "/\t/evil" would become "//evil").
 */
const HREF = '\\/(?![\\/\\\\])[^"<>\\s\\\\\\u0000-\\u001f\\u007f\\uE000\\uE001]*';
const RE = new RegExp(`<(b|kbd)>(.*?)<\\/\\1>|<a href="(${HREF})">(.*?)<\\/a>`, 'g');

/** markers to translate with in place of string values (numbers stay numbers: plural selection and number formatting) */
export function markParams(params: Record<string, string | number | null | undefined>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) out[k] = typeof v === 'number' ? v : `${OPEN}${k}${CLOSE}`;
  return out;
}

const fill = (s: string, values?: Record<string, string | number | null | undefined>): string =>
  values ? s.replace(MARK, (_all, k: string) => String(values[k] ?? '').replace(/[]/g, '')) : s;

/**
 * Splits a translated message into parts. With `values`, markers (markParams) are replaced by the values after the markup
 * was parsed, so a value can never become markup.
 */
export function richParts(src: string, values?: Record<string, string | number | null | undefined>): RichPart[] {
  const out: RichPart[] = [];
  let last = 0;
  for (const m of src.matchAll(RE)) {
    if (m.index > last) out.push({ kind: 'text', text: fill(src.slice(last, m.index), values) });
    if (m[1]) out.push({ kind: m[1] as 'b' | 'kbd', text: fill(m[2] ?? '', values) });
    else out.push({ kind: 'a', href: m[3]!, text: fill(m[4] ?? '', values) });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ kind: 'text', text: fill(src.slice(last), values) });
  return out;
}
