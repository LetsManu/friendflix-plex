import type de from '../de/version';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  egg: { hint: 'Encore {n}…', dialog: 'Nom de code de la version', kicker: 'Nom de code', close: 'Fermer' },
  snack: {
    arancini: 'Boulettes de riz frites au cœur fondant : croustillantes dehors, rebondissement dedans.',
    brezel: 'Salé, tout entortillé, et pourtant jamais perdu le fil.',
    churros: 'Cannelle, sucre, friture : la sainte trinité de la séance de minuit.',
    donut: 'Un trou au milieu, mais aucun dans le scénario.',
    eclair: 'Long, crémeux et disparu plus vite que le générique.',
    fudge: 'Aussi collant qu\'un deuxième acte, mais bien plus sucré.',
    gummibaer: 'Petits oursons, grandes émotions : chaque couleur a son arc narratif.',
    hotdog: 'Moutarde, lumière éteinte, moteur !',
    ingwerkeks: 'Assez relevé pour rester éveillé jusqu\'à la fin du générique.',
    jellybean: 'Chaque bonbon est un cliffhanger : fraise ou pop-corn ?',
    karamell: 'Colle aux dents comme un air de la bande originale.',
    lakritz: 'On adore ou on déteste, comme tout vrai film culte.',
    marshmallow: 'Moelleux, léger, et survit à chaque final d\'horreur au coin du feu.',
    nachos: 'Interdit de croquer pendant les scènes calmes. Personne n\'écoute.',
    onionring: 'Le donut des snacks salés : rond, croustillant, sans fin en vue.',
    popcorn: 'L\'original. Sans nous, ce ne serait qu\'un film.',
    quarkbaellchen: 'Petites, rondes, sucrées : le secret le mieux gardé de la boulangerie du coin.',
    reiswaffel: 'Croquer en silence est un art. On s\'entraîne encore.',
    softeis: 'Fond plus vite que ton cœur devant une comédie romantique.',
    toffee: 'Dur à l\'extérieur, tendre à l\'intérieur : un antihéros classique.',
    ube: 'Igname violette des Philippines : le dessert à rebondissement.',
    vanilleeis: 'Sous-estimée, comme le second rôle qui rafle tous les prix.',
    waffel: 'Quadrillée, chaude et jamais de trop. Sauf avec de la chantilly.',
    xocolatl: 'Le cacao des Aztèques : plus ancien que n\'importe quel film muet.',
    yuzu: 'Acide, frais et inattendu, comme un bon scénario.',
    zimtschnecke: 'Le dernier rouleau de l\'alphabet. Place au générique.',
  },
};
export default dict;
