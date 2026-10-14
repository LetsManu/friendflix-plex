// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/diagnose';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Diagnostyka ekranu',
  hint: 'Pomiary obszaru wyświetlania tego urządzenia (okno, bezpieczne marginesy, pasek kart). Zrób zrzut ekranu lub skopiuj wartości.',
  copy: 'Kopiuj wartości',
  copied: 'Skopiowano.',
  copyFailed: 'Nie udało się skopiować, zaznacz tekst.',
  airplayTitle: 'Dziennik AirPlay',
  airplayHint: 'Ostatnie zdarzenia AirPlay na tym urządzeniu (bez adresów i tokenów). Skopiuj i dołącz przy zgłaszaniu problemu.',
  airplayCopy: 'Kopiuj',
  airplayClear: 'Wyczyść',
  airplayEmpty: 'Brak wpisów.',
  timingTitle: 'Czasy startu',
  timingHint: 'Ostatnie odtworzenia na tym urządzeniu: ile trwały info, playlista, pierwszy fragment i pierwsza klatka, do tego przewijanie i przestoje.',
  timingEmpty: 'Brak pomiarów na tym urządzeniu.',
};
export default dict;
