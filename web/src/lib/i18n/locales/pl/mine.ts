import type de from '../de/mine';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  /** web app manifest (routes/manifest.webmanifest) */
  manifest: {
    description: 'Oglądajcie razem filmy i seriale',
    resumeDesc: 'Kontynuuj tam, gdzie skończyłeś',
  },
  calm: {
    title: 'Tryb spokojny',
    hint: 'Nic nie uruchamia się samo: bez zwiastuna w głównym banerze, bez podglądu po najechaniu, bez automatycznego podglądu na stronie tytułu, bez dźwięku – i mniej ruchu w całej aplikacji. Dotyczy tego profilu.',
  },
  themed: {
    eyebrow: 'Lista tematyczna',
    mark: 'Ustaw jako listę tematyczną',
    emoji: 'Ikona (emoji)',
    emojiPlaceholder: 'np. 🎃',
    color: 'Kolor okładki',
    pin: 'Pokaż na stronie głównej',
    unpin: 'Zdejmij ze strony głównej',
    pinnedHint: 'Ta lista tematyczna jest przypięta do strony głównej.',
    unfeatured: 'Ta lista była wyróżniona. Ponieważ zmienił się jej rodzaj (lista tematyczna), już nie jest – administrator może ją wyróżnić ponownie.',
    tooManyPinned: 'Można przypiąć najwyżej {max} list.',
    manageTitle: 'Listy tematyczne na stronie głównej',
    manageHint: 'Przypięte listy tematyczne pojawiają się wszystkim na stronie głównej w tej kolejności (najwyżej {max}, razem z listami wyróżnionymi).',
    moveUp: 'Przesuń {name} w górę',
    moveDown: 'Przesuń {name} w dół',
  },
};
export default dict;
