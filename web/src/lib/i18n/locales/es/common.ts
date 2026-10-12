import type de from '../de/common';
import type { Translation } from '../../types';

/** Spanish – area "common". Missing keys fall back to German (docs/i18n.md). */
const es: Translation<typeof de> = {
  appName: 'FriendFlix',
  pageTitle: '{page} – FriendFlix',
  save: 'Guardar',
  saving: 'Guardando …',
  saved: 'Guardado',
  saveFailed: 'No se pudo guardar.',
  failed: 'No ha funcionado.',
  cancel: 'Cancelar',
  close: 'Cerrar',
  done: 'Listo',
  delete: 'Eliminar',
  edit: 'Editar',
  retry: 'Reintentar',
  loading: 'Cargando …',
  more: 'Más',
  continue: 'Continuar',
  later: 'Más tarde',
  preview: 'Vista previa',
  on: 'Sí',
  off: 'No',
  standard: 'Predeterminado',
  unknown: 'desconocido',
  movies: 'Películas',
  series: 'Series',
  duration: { hm: '{h} h {m} min', h: '{h} h', m: '{m} min', s: '{s} s' },
  rating: {
    rate: 'Valorar',
    notForMe: 'No es para mí',
    like: 'Me gusta',
    love: '¡Me encanta!',
    rated: 'Valorado: {label} – cambiar valoración',
    remove: '{label} (quitar valoración)',
    saveFailed: 'No se pudo guardar la valoración.',
  },
  language: {
    label: 'Idioma',
  },
};
export default es;
