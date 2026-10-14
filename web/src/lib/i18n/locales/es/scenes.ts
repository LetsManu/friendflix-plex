// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/scenes';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  info: {
    title: 'Reparto e info',
    open: 'Reparto e info',
    openKey: 'Reparto e info (I)',
    close: 'Cerrar reparto e info',
    cast: 'Reparto',
    guests: 'Estrellas invitadas',
    facts: 'Contexto',
    as: 'como {role}',
    directors: 'Dirección',
    writers: 'Guion',
    creators: 'Creación',
    studio: 'Estudio',
    year: 'Año',
    rating: 'Clasificación por edad',
    score: 'Valoración',
    genres: 'Géneros',
    tags: 'Etiquetas',
    loading: 'Cargando reparto…',
    failed: 'No se pudo cargar el reparto ni la información.',
    none: 'No hay datos del reparto para este título.',
    person: '{name}, ver más títulos',
  },
  peek: {
    label: 'El reparto de un vistazo',
    more: 'Toda la info',
    hintKey: 'Más: {key}',
    hintTv: 'Más: OK',
  },
  person: {
    role: 'interpreta a {role}',
    more: 'Más con {name}',
    loading: 'Cargando títulos…',
    none: 'No hay más títulos en tu biblioteca.',
    failed: 'No se pudieron cargar los títulos.',
    page: 'Todos los títulos e info',
    back: 'Volver al reparto',
  },
  chapters: {
    title: 'Escenas',
    open: 'Escenas',
    close: 'Cerrar escenas',
    chapter: 'Capítulo {n}',
    current: 'Reproduciendo',
    jump: '{name}, desde {t}',
    count: { one: '{n} escena', many: '{n} escenas', other: '{n} escenas' },
  },
  audio: {
    title: 'Sonido',
    voice: 'Voces claras',
    voiceHint: 'Realzar los diálogos',
    night: 'Modo noche',
    nightHint: 'Lo fuerte más suave, lo suave más fuerte',
    on: '{name} activado',
    off: '{name} desactivado',
    unsupported: 'No disponible en este dispositivo',
    casting: 'No disponible al transmitir a otro dispositivo',
    needsTap: 'Toca la imagen o pulsa una tecla una vez y «{name}» se activará.',
  },
  shortcuts: {
    peek: 'Vistazo rápido al reparto',
  },
};
export default dict;
