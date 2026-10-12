import type de from '../de/together';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  because: 'Because you watched “{name}”',
  party: {
    reactions: 'Live reactions',
    react: 'Send reaction {emoji}',
    reacted: '{name} reacted with {emoji}',
  },
};
export default dict;
