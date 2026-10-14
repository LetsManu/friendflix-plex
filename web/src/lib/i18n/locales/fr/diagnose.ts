// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/diagnose';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Diagnostic d\'affichage',
  hint: 'Mesures de la zone d\'affichage de cet appareil (fenêtre, zones sûres, barre d\'onglets). Faites une capture d\'écran ou copiez les valeurs.',
  copy: 'Copier les valeurs',
  copied: 'Copié.',
  copyFailed: 'Copie impossible, sélectionnez le texte.',
  airplayTitle: 'Journal AirPlay',
  airplayHint: 'Les derniers événements AirPlay de cet appareil (sans adresses ni jetons). Copiez-le et joignez-le en cas de problème.',
  airplayCopy: 'Copier',
  airplayClear: 'Vider',
  airplayEmpty: 'Aucune entrée pour l’instant.',
};
export default dict;
