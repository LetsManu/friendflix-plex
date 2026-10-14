// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Plex ids <-> FriendFlix 32-hex ids. Plex ratingKeys and tag ids are small integers; FriendFlix routes, the DB and the
 * web expect 32 lowercase hex chars (id32). Encoding: "9f1e" + one kind nibble + the value as 27 zero-padded hex digits.
 * The gateway keeps its own copy of this codec; both are checked against test-vectors/plex-ids.json.
 */
export const PLEX_ID_PREFIX = '9f1e';

export const PlexIdKind = { item: 0, tag: 1, section: 2, part: 3, stream: 4 } as const;
export type PlexIdKind = keyof typeof PlexIdKind;

const KIND_BY_NIBBLE = Object.fromEntries(Object.entries(PlexIdKind).map(([k, v]) => [v, k])) as Record<number, PlexIdKind>;
const RE = /^9f1e([0-9a-f])([0-9a-f]{27})$/;
const MAX = 16n ** 27n - 1n;

export function encodePlexId(kind: PlexIdKind, value: number | string | bigint): string {
  const n = BigInt(value);
  if (n < 0n || n > MAX) throw new RangeError(`plex id out of range: ${value}`);
  return PLEX_ID_PREFIX + PlexIdKind[kind].toString(16) + n.toString(16).padStart(27, '0');
}

/** null for anything that is not a well-formed Plex id (wrong prefix, unknown kind, upper case …). */
export function decodePlexId(id: string): { kind: PlexIdKind; value: string } | null {
  const m = RE.exec(id);
  if (!m) return null;
  const kind = KIND_BY_NIBBLE[parseInt(m[1]!, 16)];
  if (!kind) return null;
  return { kind, value: BigInt('0x' + m[2]!).toString(10) };
}

/** decode and require a kind; null otherwise */
export function plexKey(id: string, kind: PlexIdKind = 'item'): string | null {
  const d = decodePlexId(id);
  return d && d.kind === kind ? d.value : null;
}
