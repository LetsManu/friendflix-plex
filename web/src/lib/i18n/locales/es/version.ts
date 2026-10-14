// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/version';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  egg: { hint: 'Faltan {n}…', dialog: 'Nombre en clave de la versión', kicker: 'Nombre en clave', close: 'Cerrar' },
  snack: {
    arancini: 'Bolitas de arroz fritas con corazón de queso: crujientes por fuera, giro argumental por dentro.',
    brezel: 'Salado, retorcido y aun así nunca pierde el hilo.',
    churros: 'Canela, azúcar y aceite: la santísima trinidad de la sesión de madrugada.',
    donut: 'Tiene un agujero en el centro, pero ninguno en la trama.',
    eclair: 'Largo, cremoso y desaparece antes que los créditos.',
    fudge: 'Tan denso como un segundo acto, pero mucho más dulce.',
    gummibaer: 'Ositos pequeños, grandes emociones: cada color tiene su propio arco.',
    hotdog: 'Mostaza, luces fuera, ¡acción!',
    ingwerkeks: 'Lo bastante picante para seguir despierto hasta los créditos.',
    jellybean: 'Cada gominola es un cliffhanger: ¿fresa o palomitas?',
    karamell: 'Se pega a los dientes como una canción de la banda sonora.',
    lakritz: 'O lo amas o lo odias, como toda película de culto.',
    marshmallow: 'Suave, esponjoso y sobrevive a cualquier final de terror junto a la hoguera.',
    nachos: 'Prohibido crujir en las escenas tranquilas. Nadie hace caso.',
    onionring: 'El donut de los snacks salados: redondo, crujiente y sin final a la vista.',
    popcorn: 'El original. Sin nosotras, esto solo sería una película.',
    quarkbaellchen: 'Pequeñas, redondas y azucaradas: el secreto mejor guardado de la panadería de la esquina.',
    reiswaffel: 'Crujir en silencio es un arte. Seguimos practicando.',
    softeis: 'Se derrite más rápido que tu corazón en una comedia romántica.',
    toffee: 'Duro por fuera, blando por dentro: un antihéroe clásico.',
    ube: 'Ñame morado de Filipinas: el postre con giro argumental.',
    vanilleeis: 'Infravalorado, como el papel secundario que se lleva todos los premios.',
    waffel: 'A cuadros, caliente y nunca demasiado. Salvo con nata.',
    xocolatl: 'El cacao de los aztecas: más antiguo que cualquier película muda.',
    yuzu: 'Ácido, fresco e inesperado, como un buen guion.',
    zimtschnecke: 'El último rollo del alfabeto. Que rueden los créditos.',
  },
};
export default dict;
