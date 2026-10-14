// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/diagnose';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Diagnostica schermo',
  hint: 'Misure dell\'area di visualizzazione di questo dispositivo (finestra, aree sicure, barra delle schede). Fai uno screenshot o copia i valori.',
  copy: 'Copia i valori',
  copied: 'Copiato.',
  copyFailed: 'Copia non riuscita, seleziona il testo.',
  airplayTitle: 'Registro AirPlay',
  airplayHint: 'Gli ultimi eventi AirPlay di questo dispositivo (senza indirizzi né token). Copialo e invialo quando segnali un problema.',
  airplayCopy: 'Copia',
  airplayClear: 'Svuota',
  airplayEmpty: 'Nessuna voce finora.',
};
export default dict;
