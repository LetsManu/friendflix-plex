import type de from '../de/anime';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  simulcast: {
    title: 'Simulcast',
    intro: 'Serie in corso con nuovi episodi nelle ultime e nelle prossime quattro settimane, per giorno della settimana.',
    onlyAnime: 'Solo anime',
    season: { winter: 'Inverno {year}', spring: 'Primavera {year}', summer: 'Estate {year}', fall: 'Autunno {year}' },
    none: 'Al momento non ci sono serie con nuovi episodi.',
    loadFailed: 'Impossibile caricare il simulcast.',
    today: 'Oggi',
    latest: 'Ultimo: {ep}',
    next: 'Prossimo: {ep} il {date}',
    airsAt: 'alle {time}',
    link: 'Simulcast',
  },
  settings: {
    original: 'Anime: audio originale con sottotitoli',
    originalHint: 'Le serie anime partono in giapponese con i sottotitoli nella tua lingua, a meno che tu non abbia scelto altro per quella serie. Senza traccia audio giapponese valgono le tue impostazioni abituali.',
  },
  comments: {
    show: 'Commenti',
    hide: 'Nascondi commenti',
    title: 'Commenti degli amici',
    count: { one: '{n} commento', many: '{n} commenti', other: '{n} commenti' },
    placeholder: 'Scrivi qualcosa su questo episodio …',
    label: 'Il tuo commento',
    send: 'Pubblica',
    empty: 'Ancora nessun commento degli amici.',
    spoiler: 'Spoiler',
    reveal: 'Spoiler – mostra comunque',
    hint: 'Non hai ancora visto questo episodio: i commenti degli altri sono nascosti.',
    delete: 'Elimina',
    deleteAria: 'Elimina il commento di {name}',
    failed: 'Impossibile salvare il commento.',
    loadFailed: 'Impossibile caricare i commenti.',
    tooMany: 'Oggi hai commentato molto. Riprova domani.',
    chars: '{n} / {max}',
    you: 'Tu',
  },
};
export default dict;
