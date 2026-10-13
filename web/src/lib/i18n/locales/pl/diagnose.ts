import type de from '../de/diagnose';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Diagnostyka ekranu',
  hint: 'Pomiary obszaru wyświetlania tego urządzenia (okno, bezpieczne marginesy, pasek kart). Zrób zrzut ekranu lub skopiuj wartości.',
  copy: 'Kopiuj wartości',
  copied: 'Skopiowano.',
  copyFailed: 'Nie udało się skopiować, zaznacz tekst.',
};
export default dict;
