/**
 * Release notes (GitHub release body = a CHANGELOG section in Markdown) as plain blocks for safe rendering:
 * the page only ever inserts text (no {@html}), so markup in the notes is shown, never executed.
 * Supported: headings (#…), bullet lists (- / *), paragraphs; inline **bold**, `code`, <kbd>…</kbd> and [links](…)
 * are reduced to their text.
 */
export type NoteBlock = { kind: 'h'; text: string } | { kind: 'ul'; items: string[] } | { kind: 'p'; text: string };

/** inline Markdown/HTML reduced to plain text */
export function plainInline(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?(?:kbd|code|b|strong|em|i|br)\s*\/?>/gi, '') // only the simple inline tags the CHANGELOG uses; anything else stays visible as text (rendered escaped, never as HTML)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .trim();
}

export function parseNotes(md: string, maxBlocks = 200): NoteBlock[] {
  const out: NoteBlock[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push({ kind: 'p', text: plainInline(para.join(' ')) }); para = []; } };
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    const li = /^[-*+]\s+(.*)$/.exec(line);
    if (h) { flush(); out.push({ kind: 'h', text: plainInline(h[1]!) }); }
    else if (li) {
      flush();
      const last = out[out.length - 1];
      if (last?.kind === 'ul') last.items.push(plainInline(li[1]!));
      else out.push({ kind: 'ul', items: [plainInline(li[1]!)] });
    } else {
      const last = out[out.length - 1];
      // indented continuation of a list item
      if (!para.length && last?.kind === 'ul' && /^\s{2,}/.test(raw)) last.items[last.items.length - 1] += ` ${plainInline(line)}`;
      else para.push(line);
    }
  }
  flush();
  return out.filter((b) => (b.kind === 'ul' ? b.items.length : b.text)).slice(0, maxBlocks);
}
