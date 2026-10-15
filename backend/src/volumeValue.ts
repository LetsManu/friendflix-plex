// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared by the `bootstrap` init container (bootstrap.ts) and the backend's readers (settings/bootstrapFiles.ts): node-free and
// import-free, so the init container still loads nothing of the app.

/**
 * The one whitespace contract of the bootstrap volume, shared by the writer and every reader (also gateway/src/env.ts): a value is
 * the file (or env) content without its trailing newlines (`echo pw > file`, CRLF too; the same as postgres' `$(< file)`). Any other
 * whitespace is part of the value. Stripping all of them makes the contract a fixed point: a written value reads back unchanged.
 */
export const stripNewlines = (v: string): string => v.replace(/(\r?\n)+$/, '');
