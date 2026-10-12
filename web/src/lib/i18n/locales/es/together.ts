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
