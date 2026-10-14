// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/together';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  because: 'Bo obejrzano „{name}”',
  party: {
    reactions: 'Reakcje na żywo',
    react: 'Wyślij reakcję {emoji}',
    reacted: '{name} reaguje: {emoji}',
  },
};
export default dict;
