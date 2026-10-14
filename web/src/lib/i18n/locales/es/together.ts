// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/together';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  because: 'Porque viste «{name}»',
  party: {
    reactions: 'Reacciones en directo',
    react: 'Enviar reacción {emoji}',
    reacted: '{name} ha reaccionado con {emoji}',
  },
};
export default dict;
