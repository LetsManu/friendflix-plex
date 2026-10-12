import type de from '../de/together';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  because: '“{name}” izlediğin için',
  party: {
    reactions: 'Canlı tepkiler',
    react: '{emoji} tepkisini gönder',
    reacted: '{name} şu tepkiyi verdi: {emoji}',
  },
};
export default dict;
