import type de from '../de/mine';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  /** web app manifest (routes/manifest.webmanifest) */
  manifest: {
    description: 'Ve películas y series juntos',
    resumeDesc: 'Continúa donde lo dejaste',
  },
  calm: {
    title: 'Modo tranquilo',
    hint: 'Nada empieza por sí solo: sin tráiler en el banner principal, sin avance al pasar el ratón, sin avance automático en la ficha, sin sonido – y menos movimiento en toda la aplicación. Se aplica a este perfil.',
  },
  themed: {
    eyebrow: 'Lista temática',
    mark: 'Presentar como lista temática',
    emoji: 'Icono (emoji)',
    emojiPlaceholder: 'p. ej. 🎃',
    color: 'Color de portada',
    pin: 'Mostrar en el inicio',
    unpin: 'Quitar del inicio',
    pinnedHint: 'Esta lista temática está fijada en el inicio.',
    unfeatured: 'Esta lista estaba destacada. Como cambió su tipo (lista temática), ya no lo está; un admin puede volver a destacarla.',
    tooManyPinned: 'No se pueden fijar más de {max} listas.',
    manageTitle: 'Listas temáticas en el inicio',
    manageHint: 'Las listas temáticas fijadas aparecen en el inicio de todos, en este orden (como máximo {max}, junto con las listas destacadas).',
    moveUp: 'Subir {name}',
    moveDown: 'Bajar {name}',
  },
};
export default dict;
