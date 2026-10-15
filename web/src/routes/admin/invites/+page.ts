// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** The invites moved into a tab of /admin/users (Block 23); old links and bookmarks land there. */
import { redirect } from '@sveltejs/kit';

export function load(): never {
  redirect(307, '/admin/users?tab=invites');
}
