import type de from '../de/anime';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  simulcast: {
    title: 'Simulcast',
    intro: 'Son dört haftada ve önümüzdeki dört haftada yeni bölümü olan devam eden diziler, haftanın gününe göre.',
    onlyAnime: 'Yalnızca anime',
    season: { winter: 'Kış {year}', spring: 'İlkbahar {year}', summer: 'Yaz {year}', fall: 'Sonbahar {year}' },
    none: 'Şu anda yeni bölümü olan dizi yok.',
    loadFailed: 'Simulcast yüklenemedi.',
    today: 'Bugün',
    latest: 'Son: {ep}',
    next: 'Sonraki: {ep}, {date}',
    airsAt: 'saat {time}',
    link: 'Simulcast',
  },
  settings: {
    original: 'Anime: Altyazılı orijinal ses',
    originalHint: 'Anime dizileri, o dizi için başka bir seçim yapmadıysan Japonca sesle ve kendi dilinde altyazıyla başlar. Japonca ses parçası yoksa normal ayarların geçerli olur.',
  },
  comments: {
    show: 'Yorumlar',
    hide: 'Yorumları gizle',
    title: 'Arkadaşların yorumları',
    count: { one: '{n} yorum', other: '{n} yorum' },
    placeholder: 'Bu bölüm hakkında bir şey yaz …',
    label: 'Yorumun',
    send: 'Gönder',
    empty: 'Henüz arkadaş yorumu yok.',
    spoiler: 'Spoiler',
    reveal: 'Spoiler – yine de göster',
    hint: 'Bu bölümü henüz izlemedin – başkalarının yorumları gizli.',
    delete: 'Sil',
    deleteAria: '{name} kişisinin yorumunu sil',
    failed: 'Yorum kaydedilemedi.',
    loadFailed: 'Yorumlar yüklenemedi.',
    tooMany: 'Bugün çok fazla yorum yaptın. Yarın tekrar dene.',
    chars: '{n} / {max}',
    you: 'Sen',
  },
};
export default dict;
