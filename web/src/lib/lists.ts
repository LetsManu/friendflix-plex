// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { api, ApiError, type Item } from '#lib/api';
import { tr } from '#lib/i18n';

export type ListRole = 'owner' | 'editor' | 'viewer' | 'guest';
export interface ListSummary { id: string; name: string; description: string | null; owner: { id: string; name: string }; role: ListRole; itemCount: number; memberCount: number; updatedAt: string; coverIds: string[]; themed?: boolean; emoji?: string | null; coverColor?: string | null }
export interface ListMember { id: string; name: string; role: ListRole }
export type ListItem = Item & { addedBy: { id: string; name: string } | null; addedAt: string; note: string | null };
/** look of a themed list ("Themenliste"): optional emoji and #rrggbb cover colour */
export interface ThemedLook { themed?: boolean; emoji?: string | null; coverColor?: string | null; /** pinned to the home page by an admin */ pinned?: boolean }
/** `owner` is null for kids profiles (no people on editorial pages) */
export interface ListDetail { list: { id: string; name: string; description: string | null; owner: { id: string; name: string } | null; role: ListRole } & ThemedLook; members: ListMember[]; items: ListItem[]; hiddenCount: number }
export interface PickerList { id: string; name: string; contains: boolean; canEdit: boolean }

export interface FeaturedList { id: string; name: string; description: string | null; owner: { name: string }; items: Item[] }
export const loadFeatured = () => api<{ lists: FeaturedList[] }>('/api/lists/featured').then((r) => r.lists);

/** role names in the current UI language (getters: translated when read, so the object can be used like a plain map) */
export const roleLabel: Record<ListRole, string> = {
  get owner() { return tr('detail.lists.role.owner'); },
  get editor() { return tr('detail.lists.role.editor'); },
  get viewer() { return tr('detail.lists.role.viewer'); },
  get guest() { return tr('detail.lists.role.guest'); },
};

export const loadLists = () => api<{ lists: ListSummary[] }>('/api/lists').then((r) => r.lists);
export const loadList = (id: string) => api<ListDetail>(`/api/lists/${id}`);
export const createList = (name: string, description?: string, look?: { themed: boolean; emoji?: string; coverColor?: string }) =>
  api<{ id: string }>('/api/lists', { method: 'POST', body: { name, description: description || undefined, ...look } });
export const itemLists = (itemId: string) => api<{ lists: PickerList[] }>(`/api/items/${itemId}/lists`).then((r) => r.lists);
export const addToList = (listId: string, itemId: string, note?: string) => api(`/api/lists/${listId}/items`, { method: 'POST', body: { itemId, note: note || undefined } });
export const removeFromList = (listId: string, itemId: string) => api(`/api/lists/${listId}/items/${itemId}`, { method: 'DELETE' });
export const setMember = (listId: string, userId: string, role: 'editor' | 'viewer') => api(`/api/lists/${listId}/members/${userId}`, { method: 'PUT', body: { role } });
export const removeMember = (listId: string, userId: string) => api(`/api/lists/${listId}/members/${userId}`, { method: 'DELETE' });

/** Only a real 404 means "does not exist"; anything else (502, network, …) is a load failure worth a retry. */
export const isNotFound = (e: unknown): boolean => e instanceof ApiError && e.status === 404;

/** Featured themed list as a home row (GET /api/lists/themed; `owner` missing for kids profiles). */
export interface ThemedList { id: string; name: string; description: string | null; emoji: string | null; coverColor: string | null; owner?: { name: string }; items: Item[] }
export const loadThemed = () => api<{ lists: ThemedList[] }>('/api/lists/themed').then((r) => r.lists);

/** Admin overview of all themed lists (pinned = shown on the home page, in the returned order). */
export interface ManagedThemed { id: string; name: string; emoji: string | null; owner: { name: string }; itemCount: number; pinned: boolean }
export const loadManagedThemed = () => api<{ lists: ManagedThemed[]; max: number }>('/api/lists/themed/manage');
export const pinThemed = (id: string, pinned: boolean) => api(`/api/lists/${id}/pin`, { method: 'PUT', body: { pinned } });
export const orderThemed = (ids: string[]) => api('/api/lists/themed/order', { method: 'PUT', body: { ids } });
export const saveLook = (id: string, look: { themed?: boolean; emoji?: string | null; coverColor?: string | null }) => api<{ ok: boolean; unfeatured?: boolean }>(`/api/lists/${id}`, { method: 'PATCH', body: look });

/** Cover palette offered for themed lists (dark enough for white text). */
export const COVER_COLORS = ['#7a1f3d', '#a33b20', '#9a6a00', '#2f6b3a', '#1f5f7a', '#3a3a8c', '#6a2c91', '#3d4450'] as const;
/** CSS gradient for the header / row accent of a themed list (neutral dark when no colour is set). */
export const coverGradient = (color: string | null | undefined): string => {
  const c = color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#3d4450';
  return `linear-gradient(135deg, ${c} 0%, color-mix(in srgb, ${c} 45%, #101418) 55%, #101418 100%)`;
};
/** Moves entry `from` to `to` (returns a new array). */
export function moveItem<T>(a: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= a.length || to >= a.length) return [...a];
  const out = [...a];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x!);
  return out;
}
