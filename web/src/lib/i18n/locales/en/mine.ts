// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/mine';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  /** web app manifest (routes/manifest.webmanifest) */
  manifest: {
    description: 'Watch films and series together',
    resumeDesc: 'Pick up where you left off',
  },
  calm: {
    title: 'Calm mode',
    hint: 'Nothing starts by itself: no trailer in the main banner, no preview when you hover a title, no automatic preview on the detail page, no sound with them – and less motion across the whole app. Applies to this profile.',
  },
  themed: {
    eyebrow: 'Themed list',
    mark: 'Style as a themed list',
    emoji: 'Icon (emoji)',
    emojiPlaceholder: 'e.g. 🎃',
    color: 'Cover colour',
    pin: 'Show on the home page',
    unpin: 'Remove from the home page',
    pinnedHint: 'This themed list is pinned to the home page.',
    unfeatured: 'This list was featured. Because its kind (themed list) changed, it no longer is – an admin can feature it again.',
    tooManyPinned: 'No more than {max} lists can be pinned.',
    manageTitle: 'Themed lists on the home page',
    manageHint: 'Pinned themed lists appear on everyone\'s home page in this order (at most {max}, shared with the featured lists).',
    moveUp: 'Move {name} up',
    moveDown: 'Move {name} down',
  },
};
export default dict;
