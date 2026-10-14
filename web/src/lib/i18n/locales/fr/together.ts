// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/together';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  because: 'Parce que vous avez regardé « {name} »',
  party: {
    reactions: 'Réactions en direct',
    react: 'Envoyer la réaction {emoji}',
    reacted: '{name} a réagi avec {emoji}',
  },
};
export default dict;
