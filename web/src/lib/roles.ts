// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { hasKey, trDynamic } from '#lib/i18n';

/** A role as /api/admin/roles reports it: `builtinLabel` = the label is the built-in default of that role. */
export interface RoleInfo { label: string; builtinLabel?: boolean }

/**
 * Name of a role in the UI language. Translated only when the server label is the built-in default (`builtinLabel`);
 * a label renamed via ROLES_JSON (or a role without a translation) is shown as configured. Mirrors roleLabel() in
 * backend/src/i18n.ts. Without role info (not loaded yet) the role key is shown.
 */
export function roleName(role: string, info: RoleInfo | null | undefined): string {
  if (!info) return role;
  const key = `admin.roleNames.${role}`;
  return info.builtinLabel && hasKey(key) ? trDynamic(key) : info.label || role;
}
