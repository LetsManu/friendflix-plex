import type de from '../de/common';
import type { Translation } from '../../types';

/** Turkish – area "common". Missing keys fall back to German (docs/i18n.md). */
const tr: Translation<typeof de> = {
  appName: 'FriendFlix',
  pageTitle: '{page} – FriendFlix',
  saved: 'Kaydedildi',
  saving: 'Kaydediliyor …',
  save: 'Kaydet',
  saveFailed: 'Kaydedilemedi.',
  failed: 'İşlem başarısız oldu.',
  cancel: 'İptal',
  close: 'Kapat',
  done: 'Bitti',
  delete: 'Sil',
  edit: 'Düzenle',
  retry: 'Yeniden yükle',
  loading: 'Yükleniyor …',
  more: 'Daha fazla',
  continue: 'Devam',
  later: 'Sonra',
  preview: 'Önizleme',
  on: 'Açık',
  off: 'Kapalı',
  standard: 'Varsayılan',
  unknown: 'bilinmiyor',
  movies: 'Filmler',
  series: 'Diziler',
  duration: { hm: '{h} sa {m} dk', h: '{h} sa', m: '{m} dk', s: '{s} sn' },
  rating: {
    rate: 'Puanla',
    notForMe: 'Bana göre değil',
    like: 'Beğendim',
    love: 'Harika',
    rated: 'Puanın: {label} – puanı değiştir',
    remove: '{label} (puanı kaldır)',
    saveFailed: 'Puan kaydedilemedi.',
  },
  language: {
    label: 'Dil',
  },
};
export default tr;
