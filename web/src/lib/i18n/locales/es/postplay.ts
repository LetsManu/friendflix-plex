// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/postplay';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  card: { title: '¿Terminado? Mira lo que viene', open: '¿Y ahora qué?', close: 'Ocultar este aviso' },
  head: {
    movieEnd: 'Has visto «{title}»',
    seriesFinished: 'Has terminado «{title}»',
    caughtUp: 'Estás al día',
    gap: 'El episodio {n} sigue sin ver',
    nextPart: 'Lo siguiente en «{name}»: {title}',
    nextEpisode: 'A continuación: {title}',
  },
  sub: {
    caughtUp: 'Has visto todos los episodios disponibles de «{title}».',
    nextAir: 'Próximo episodio el {date}',
    noDate: 'El próximo episodio aún no tiene fecha.',
    gap: '«{title}»: te saltaste este episodio.',
  },
  justWatched: 'Visto ahora',
  hero: 'Nuestra recomendación para ti',
  action: {
    play: 'Reproducir',
    playTitle: 'Reproducir «{title}»',
    jumpBack: 'Volver al episodio {n}',
    remind: 'Recuérdamelo',
    reminded: 'Recordatorio activado',
    remindFailed: 'No se pudo guardar el recordatorio.',
    wish: 'Pedir la temporada que falta',
    wished: 'Pedido',
    wishLeft: { one: 'Te queda {n} petición este mes', many: 'Te quedan {n} de peticiones este mes', other: 'Te quedan {n} peticiones este mes' },
    wishLimit: 'Has alcanzado el límite mensual de peticiones.',
    wishFailed: 'La petición no se pudo enviar.',
    addList: 'Añadir a mi lista',
    onList: 'En mi lista',
    listFailed: 'No se pudo guardar tu lista.',
    notInterested: 'No me interesa',
    notInterestedDone: 'Entendido: no volveremos a sugerirte «{title}».',
    undo: 'Deshacer',
    undone: 'Deshecho.',
    back: 'Volver al título',
    details: 'Detalles',
  },
  row: {
    continuation: 'Sigue viendo',
    transition: 'Lo que otros ven después de «{name}»',
    universe: 'El mismo universo: {name}',
    because: 'Porque viste «{name}»',
    friends: 'A tus amigos les gustó',
    taste: 'Va con tus gustos',
  },
  why: { seed: 'Por «{name}»', friends: 'Bien valorado por tus amigos' },
  spoiler: 'Episodio sin ver: vista previa oculta',
  episode: 'T{s}:E{e} · {name}',
  pageTitle: '¿Y ahora qué?',
  loading: 'Cargando sugerencias …',
  error: 'No se pudieron cargar las sugerencias.',
  empty: 'Ahora mismo no tenemos sugerencias para ti.',
  settings: {
    label: 'Mostrar sugerencias tras el último episodio',
    hint: 'Después de una película o del último episodio disponible: lo que viene, títulos parecidos y consejos. Nada empieza solo.',
  },
};
export default dict;
