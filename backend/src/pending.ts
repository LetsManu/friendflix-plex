// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
/** kv `pending_notice:<request id>` → { sub, email } of an approved request (lets /pending answer "approved") */
export const pendingNoticeKey = (requestId: string) => `pending_notice:${requestId}`;
