// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/version';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  egg: { hint: 'Jeszcze {n}…', dialog: 'Nazwa kodowa wersji', kicker: 'Nazwa kodowa', close: 'Zamknij' },
  snack: {
    arancini: 'Smażone kulki ryżowe z serowym sercem: chrupiące z zewnątrz, zwrot akcji w środku.',
    brezel: 'Słony, poskręcany, a mimo to nigdy nie gubi wątku.',
    churros: 'Cynamon, cukier, olej: święta trójca nocnego seansu.',
    donut: 'Ma dziurę w środku, ale żadnej w fabule.',
    eclair: 'Długi, kremowy i znika szybciej niż napisy końcowe.',
    fudge: 'Ciągnie się jak drugi akt, tylko jest dużo słodszy.',
    gummibaer: 'Małe misie, wielkie emocje: każdy kolor ma własny łuk postaci.',
    hotdog: 'Musztarda, światła gasną, akcja!',
    ingwerkeks: 'Na tyle ostre, że nie zaśniesz aż do napisów końcowych.',
    jellybean: 'Każda fasolka to cliffhanger: truskawka czy popcorn?',
    karamell: 'Klei się do zębów jak melodia ze ścieżki dźwiękowej.',
    lakritz: 'Albo ją kochasz, albo nienawidzisz, jak każdy prawdziwy film kultowy.',
    marshmallow: 'Miękka, puszysta i przetrwa każdy finał horroru przy ognisku.',
    nachos: 'Chrupanie w cichych scenach jest zabronione. Nikt nie słucha.',
    onionring: 'Pączek wśród słonych przekąsek: okrągły, chrupiący, bez końca.',
    popcorn: 'Oryginał. Bez nas to byłby po prostu film.',
    quarkbaellchen: 'Małe, okrągłe i posypane cukrem: najlepiej strzeżony sekret piekarni za rogiem.',
    reiswaffel: 'Ciche chrupanie to sztuka. Wciąż ćwiczymy.',
    softeis: 'Topnieje szybciej niż twoje serce na komedii romantycznej.',
    toffee: 'Twarde z zewnątrz, miękkie w środku: klasyczny antybohater.',
    ube: 'Fioletowy pochrzyn z Filipin: deser ze zwrotem akcji.',
    vanilleeis: 'Niedoceniane, jak rola drugoplanowa, która zgarnia wszystkie nagrody.',
    waffel: 'W kratkę, ciepły i nigdy za dużo. Chyba że z bitą śmietaną.',
    xocolatl: 'Kakao Azteków: starsze niż jakikolwiek film niemy.',
    yuzu: 'Kwaśne, świeże i zaskakujące, jak dobry scenariusz.',
    zimtschnecke: 'Ostatnia rolka alfabetu. Czas na napisy końcowe.',
  },
};
export default dict;
