// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
declare global {
  namespace App {
    interface PageState {
      modalId?: string;
      /** the post-play overlay is open over the watch page (one shallow history entry; browser / phone Back closes it) */
      postplay?: string;
    }
  }
}
export {};
