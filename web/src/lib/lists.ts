import { api, ApiError, type Item } from '#lib/api';
import { tr } from '#lib/i18n';

export type ListRole = 'owner' | 'editor' | 'viewer' | 'guest';
export interface ListSummary { id: string; name: string; description: string | null; owner: { id: string; name: string }; role: ListRole; itemCount: number; memberCount: number; updatedAt: string; coverIds: string[] }
export interface ListMember { id: string; name: string; role: ListRole }
export type ListItem = Item & { addedBy: { id: string; name: string } | null; addedAt: string; note: string | null };
export interface ListDetail { list: { id: string; name: string; description: string | null; owner: { id: string; name: string }; role: ListRole }; members: ListMember[]; items: ListItem[]; hiddenCount: number }
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
export const createList = (name: string, description?: string) => api<{ id: string }>('/api/lists', { method: 'POST', body: { name, description: description || undefined } });
export const itemLists = (itemId: string) => api<{ lists: PickerList[] }>(`/api/items/${itemId}/lists`).then((r) => r.lists);
export const addToList = (listId: string, itemId: string, note?: string) => api(`/api/lists/${listId}/items`, { method: 'POST', body: { itemId, note: note || undefined } });
export const removeFromList = (listId: string, itemId: string) => api(`/api/lists/${listId}/items/${itemId}`, { method: 'DELETE' });
export const setMember = (listId: string, userId: string, role: 'editor' | 'viewer') => api(`/api/lists/${listId}/members/${userId}`, { method: 'PUT', body: { role } });
export const removeMember = (listId: string, userId: string) => api(`/api/lists/${listId}/members/${userId}`, { method: 'DELETE' });

/** Only a real 404 means "does not exist"; anything else (502, network, …) is a load failure worth a retry. */
export const isNotFound = (e: unknown): boolean => e instanceof ApiError && e.status === 404;
