import type de from '../de/together';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  because: 'Perché hai guardato “{name}”',
  party: {
    reactions: 'Reazioni in diretta',
    react: 'Invia la reazione {emoji}',
    reacted: '{name} ha reagito con {emoji}',
  },
};
export default dict;
