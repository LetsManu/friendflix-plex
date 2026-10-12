import type de from '../de/ui';
import type { Translation } from '../../types';

/** Español – área «ui» (kit de interfaz compartido). */
const dict: Translation<typeof de> = {
  done: 'Hecho.',
  undo: 'Deshacer',
  undone: 'Deshecho.',
  retry: 'Reintentar',
  dismiss: 'Cerrar aviso',
  notifications: 'Avisos',
  errorPrefix: 'Error:',
  percent: '{n} %',
  confirm: {
    ok: 'Confirmar',
    cancel: 'Cancelar',
    delete: 'Eliminar',
    typeToConfirm: 'Escribe «{word}» para confirmar',
  },
  error: {
    generic: 'No ha funcionado.',
    network: 'Sin conexión con el servidor.',
    forbidden: 'No tienes permiso para hacer esto.',
    notFound: 'Esto no existe (o ya no existe).',
    conflict: 'Ahora no es posible: algo ha cambiado mientras tanto.',
    tooMany: 'Demasiados intentos. Espera un momento.',
    server: 'Error del servidor. Inténtalo de nuevo más tarde.',
  },
  table: {
    filter: 'Filtrar tabla',
    filterPlaceholder: 'Buscar…',
    clearFilter: 'Quitar filtro',
    sortAsc: '(orden ascendente)',
    sortDesc: '(orden descendente)',
    empty: 'No hay entradas.',
    noMatch: 'No hay resultados para «{q}».',
    loading: 'Cargando…',
    range: '{from}–{to} de {total}',
    pages: 'Páginas',
    prev: 'Página anterior',
    next: 'Página siguiente',
    actions: 'Acciones',
    actionsFor: 'Acciones para {name}',
  },
  copy: {
    copy: 'Copiar',
    copied: 'Copiado al portapapeles.',
    failed: 'No se pudo copiar: selecciona el texto y cópialo manualmente.',
    qr: 'Código QR',
    qrShow: 'Mostrar código QR',
    qrHide: 'Ocultar código QR',
  },
};
export default dict;
