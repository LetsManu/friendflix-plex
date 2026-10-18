// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/reco';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  because: 'Porque viste «{seed}»',
  picked: 'Elegido para ti',
  trait: {
    friends: 'lo valoraron tus amigos', friendsNamed: 'lo valoraron {names}', next: 'la gente ve esto después', together: 'se suele ver junto', universe: 'mismo universo',
    director: 'mismo director', directorNamed: 'mismo director ({name})', actor: 'mismo reparto', actorNamed: 'con {name}',
    studioNamed: 'de {name}', genreNamed: 'género: {name}',
  },
  why: { button: '¿Por qué veo esto?', heading: '¿Por qué estos títulos?', item: '{name}: {reason}', none: 'Encaja con tus gustos.', close: 'Ocultar' },
  settings: {
    title: 'Recomendaciones',
    reset: 'Restablecer mis recomendaciones',
    resetHint: 'Olvida tu perfil de gustos aprendido y qué filas pulsas. Tu lista, tus valoraciones y tu historial se conservan. Después las recomendaciones se reconstruyen a partir de tu historial.',
    resetDone: 'Restablecido. Se están recalculando las recomendaciones.',
    resetFailed: 'No se pudo restablecer.',
    whyHint: 'Pulsa la línea bajo una recomendación («Porque viste …») para ver por qué aparece un título.',
  },
  admin: {
    title: 'Motor de recomendaciones',
    intro: 'Tasa de clics y de reproducción por motor, calculadas con los contadores de este servidor. Los contadores empiezan de cero en cada reinicio.',
    active: 'Activo: {engine}',
    engine: { v1: 'v1 (Jellyfin)', v2: 'v2 (modelo propio)', shadow: 'Shadow (v2 se ejecuta en paralelo)' },
    col: { engine: 'Motor', shown: 'Mostradas', clicks: 'Clics', plays: 'Reproducidas', dismissed: 'Descartadas', ctr: 'Tasa de clics', playRate: 'Tasa de reproducción' },
    fallbacks: 'Retrocesos a v1: {n}',
    since: 'Contado desde {date}',
    empty: '–',
    loadFailed: 'No se pudieron cargar las cifras.',
  },
};

export default dict;
