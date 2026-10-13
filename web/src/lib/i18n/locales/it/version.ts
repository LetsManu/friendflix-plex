import type de from '../de/version';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  egg: { hint: 'Ancora {n}…', dialog: 'Nome in codice della versione', kicker: 'Nome in codice', close: 'Chiudi' },
  snack: {
    arancini: 'Palline di riso fritte con il cuore filante: croccanti fuori, colpo di scena dentro.',
    brezel: 'Salato, attorcigliato, eppure non perde mai il filo.',
    churros: 'Cannella, zucchero e olio: la santa trinità dell\'ultimo spettacolo.',
    donut: 'Ha un buco nel mezzo, ma nessuno nella trama.',
    eclair: 'Lungo, cremoso e sparito prima dei titoli di coda.',
    fudge: 'Denso come un secondo atto, ma molto più dolce.',
    gummibaer: 'Orsetti piccoli, grandi emozioni: ogni colore ha il suo arco narrativo.',
    hotdog: 'Senape, luci spente, si gira.',
    ingwerkeks: 'Abbastanza piccante da tenerti sveglio fino ai titoli di coda.',
    jellybean: 'Ogni caramella è un cliffhanger: fragola o popcorn?',
    karamell: 'Si attacca ai denti come un tormentone della colonna sonora.',
    lakritz: 'O la ami o la odi, come ogni vero film di culto.',
    marshmallow: 'Morbido, soffice e sopravvive a ogni finale horror attorno al falò.',
    nachos: 'Vietato sgranocchiare nelle scene silenziose. Nessuno ascolta.',
    onionring: 'La ciambella degli snack salati: rotonda, croccante, senza fine.',
    popcorn: 'L\'originale. Senza di noi sarebbe solo un film.',
    quarkbaellchen: 'Piccole, rotonde e zuccherate: il segreto meglio custodito del forno sotto casa.',
    reiswaffel: 'Sgranocchiare in silenzio è un\'arte. Ci stiamo ancora esercitando.',
    softeis: 'Si scioglie più in fretta del tuo cuore in una commedia romantica.',
    toffee: 'Duro fuori, morbido dentro: un classico antieroe.',
    ube: 'Igname viola delle Filippine: il dessert col colpo di scena.',
    vanilleeis: 'Sottovalutato, come il ruolo secondario che vince tutti i premi.',
    waffel: 'A quadretti, caldo e mai troppo. Tranne con la panna.',
    xocolatl: 'Il cacao degli Aztechi: più antico di qualsiasi film muto.',
    yuzu: 'Aspro, fresco e inaspettato, come una buona sceneggiatura.',
    zimtschnecke: 'L\'ultimo rotolo dell\'alfabeto. Titoli di coda.',
  },
};
export default dict;
