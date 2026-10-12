import type de from '../de/anime';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  simulcast: {
    title: 'Simulcast',
    intro: 'Series en emisión con episodios nuevos en las últimas y las próximas cuatro semanas, por día de la semana.',
    onlyAnime: 'Solo anime',
    season: { winter: 'Invierno {year}', spring: 'Primavera {year}', summer: 'Verano {year}', fall: 'Otoño {year}' },
    none: 'Ahora mismo no hay series con episodios nuevos.',
    loadFailed: 'No se pudo cargar el simulcast.',
    today: 'Hoy',
    latest: 'Último: {ep}',
    next: 'Siguiente: {ep} el {date}',
    airsAt: 'a las {time}',
    link: 'Simulcast',
  },
  settings: {
    original: 'Anime: versión original con subtítulos',
    originalHint: 'Las series de anime empiezan en japonés con subtítulos en tu idioma, salvo que hayas elegido otra cosa para esa serie. Si no hay pista de audio en japonés, se aplican tus ajustes habituales.',
  },
  comments: {
    show: 'Comentarios',
    hide: 'Ocultar comentarios',
    title: 'Comentarios de amigos',
    count: { one: '{n} comentario', many: '{n} comentarios', other: '{n} comentarios' },
    placeholder: 'Escribe algo sobre este episodio …',
    label: 'Tu comentario',
    send: 'Publicar',
    empty: 'Aún no hay comentarios de amigos.',
    spoiler: 'Spoiler',
    reveal: 'Spoiler – mostrar de todos modos',
    hint: 'Aún no has visto este episodio: los comentarios de los demás están ocultos.',
    delete: 'Eliminar',
    deleteAria: 'Eliminar el comentario de {name}',
    failed: 'No se pudo guardar el comentario.',
    loadFailed: 'No se pudieron cargar los comentarios.',
    tooMany: 'Hoy has comentado mucho. Inténtalo de nuevo mañana.',
    chars: '{n} / {max}',
    you: 'Tú',
  },
};
export default dict;
