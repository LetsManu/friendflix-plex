// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/diagnose';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Diagnóstico de pantalla',
  hint: 'Mediciones del área de visualización de este dispositivo (ventana, zonas seguras, barra de pestañas). Haz una captura o copia los valores.',
  copy: 'Copiar valores',
  copied: 'Copiado.',
  copyFailed: 'No se pudo copiar, selecciona el texto.',
  airplayTitle: 'Registro de AirPlay',
  airplayHint: 'Los últimos eventos de AirPlay de este dispositivo (sin direcciones ni tokens). Cópialo y envíalo si informas de un problema.',
  airplayCopy: 'Copiar',
  airplayClear: 'Vaciar',
  airplayEmpty: 'Aún no hay entradas.',
};
export default dict;
