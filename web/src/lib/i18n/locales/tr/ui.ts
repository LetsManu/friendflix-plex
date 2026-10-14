// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/ui';
import type { Translation } from '../../types';

/** Türkçe – "ui" alanı (ortak arayüz kiti). */
const dict: Translation<typeof de> = {
  done: 'Tamam.',
  undo: 'Geri al',
  undone: 'Geri alındı.',
  retry: 'Tekrar dene',
  dismiss: 'Bildirimi kapat',
  notifications: 'Bildirimler',
  errorPrefix: 'Hata:',
  percent: '%{n}',
  confirm: {
    ok: 'Onayla',
    cancel: 'İptal',
    delete: 'Sil',
    typeToConfirm: 'Onaylamak için “{word}” yazın',
  },
  error: {
    generic: 'Bu işe yaramadı.',
    network: 'Sunucuya bağlantı yok.',
    forbidden: 'Bunu yapma yetkiniz yok.',
    notFound: 'Bu (artık) mevcut değil.',
    conflict: 'Şu anda mümkün değil – bu arada bir şey değişti.',
    tooMany: 'Çok fazla deneme. Lütfen biraz bekleyin.',
    server: 'Sunucu hatası. Lütfen daha sonra tekrar deneyin.',
  },
  table: {
    filter: 'Tabloyu filtrele',
    filterPlaceholder: 'Ara…',
    clearFilter: 'Filtreyi temizle',
    sortAsc: '(artan sıralı)',
    sortDesc: '(azalan sıralı)',
    empty: 'Kayıt yok.',
    noMatch: '“{q}” için sonuç yok.',
    loading: 'Yükleniyor…',
    range: '{from}–{to} / {total}',
    pages: 'Sayfalar',
    prev: 'Önceki sayfa',
    next: 'Sonraki sayfa',
    actions: 'İşlemler',
    actionsFor: '{name} için işlemler',
  },
  copy: {
    copy: 'Kopyala',
    copied: 'Panoya kopyalandı.',
    failed: 'Kopyalanamadı – lütfen metni seçip elle kopyalayın.',
    qr: 'QR kodu',
    qrShow: 'QR kodunu göster',
    qrHide: 'QR kodunu gizle',
  },
};
export default dict;
