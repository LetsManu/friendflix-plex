import type de from '../de/anime';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  simulcast: {
    title: 'Simulcast',
    intro: 'Emitowane seriale z nowymi odcinkami z ostatnich i najbliższych czterech tygodni, według dnia tygodnia.',
    onlyAnime: 'Tylko anime',
    season: { winter: 'Zima {year}', spring: 'Wiosna {year}', summer: 'Lato {year}', fall: 'Jesień {year}' },
    none: 'Obecnie nie ma seriali z nowymi odcinkami.',
    loadFailed: 'Nie udało się wczytać simulcastu.',
    today: 'Dziś',
    latest: 'Ostatni: {ep}',
    next: 'Następny: {ep}, {date}',
    airsAt: 'o {time}',
    link: 'Simulcast',
  },
  settings: {
    original: 'Anime: oryginalny dźwięk z napisami',
    originalHint: 'Seriale anime startują po japońsku z napisami w twoim języku – chyba że dla danego serialu wybrano coś innego. Bez japońskiej ścieżki dźwiękowej obowiązują twoje zwykłe ustawienia.',
  },
  comments: {
    show: 'Komentarze',
    hide: 'Ukryj komentarze',
    title: 'Komentarze znajomych',
    count: { one: '{n} komentarz', few: '{n} komentarze', many: '{n} komentarzy', other: '{n} komentarza' },
    placeholder: 'Napisz coś o tym odcinku …',
    label: 'Twój komentarz',
    send: 'Opublikuj',
    empty: 'Brak komentarzy znajomych.',
    spoiler: 'Spoiler',
    reveal: 'Spoiler – pokaż mimo to',
    hint: 'Nie obejrzano jeszcze tego odcinka – komentarze innych są ukryte.',
    delete: 'Usuń',
    deleteAria: 'Usuń komentarz użytkownika {name}',
    failed: 'Nie udało się zapisać komentarza.',
    loadFailed: 'Nie udało się wczytać komentarzy.',
    tooMany: 'Dziś skomentowano już bardzo dużo. Spróbuj jutro.',
    chars: '{n} / {max}',
    you: 'Ty',
  },
};
export default dict;
