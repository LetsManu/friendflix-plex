// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/postplay';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  card: { title: 'Bitti mi? Sırada ne var, bak', open: 'Sırada ne var?', close: 'Bu ipucunu gizle' },
  head: {
    movieEnd: '“{title}” izlendi',
    seriesFinished: '“{title}” bitti',
    caughtUp: 'Her şeyi izledin',
    gap: '{n}. bölüm henüz izlenmedi',
    nextPart: '“{name}” serisinde sıradaki: {title}',
    nextEpisode: 'Sıradaki: {title}',
  },
  sub: {
    caughtUp: '“{title}” dizisinin mevcut tüm bölümlerini izledin.',
    nextAir: 'Sonraki bölüm {date} tarihinde',
    noDate: 'Sonraki bölüm için henüz tarih yok.',
    gap: '“{title}”: bu bölümü atladın.',
  },
  justWatched: 'Az önce izlendi',
  hero: 'Senin için önerimiz',
  action: {
    play: 'Oynat',
    playTitle: '“{title}” oynat',
    jumpBack: '{n}. bölüme dön',
    remind: 'Bana hatırlat',
    reminded: 'Hatırlatıcı açık',
    remindFailed: 'Hatırlatıcı kaydedilemedi.',
    wish: 'Eksik sezonu iste',
    wished: 'İstendi',
    wishLeft: { one: 'Bu ay {n} istek hakkın kaldı', other: 'Bu ay {n} istek hakkın kaldı' },
    wishLimit: 'Bu ayki istek sınırına ulaştın.',
    wishFailed: 'İstek gönderilemedi.',
    addList: 'Listeme ekle',
    onList: 'Listende',
    listFailed: 'Listen kaydedilemedi.',
    notInterested: 'İlgilenmiyorum',
    notInterestedDone: 'Anlaşıldı: “{title}” artık önerilmeyecek.',
    undo: 'Geri al',
    undone: 'Geri alındı.',
    back: 'Başlığa geri dön',
    details: 'Ayrıntılar',
  },
  row: {
    continuation: 'Devam et',
    transition: 'Başkaları “{name}” sonrasında ne izliyor',
    universe: 'Aynı evren: {name}',
    because: '“{name}” izlediğin için',
    friends: 'Arkadaşların bunu beğendi',
    taste: 'Zevkine uygun',
  },
  why: { seed: '“{name}” nedeniyle', friends: 'Arkadaşların yüksek puan verdi' },
  spoiler: 'İzlenmemiş bölüm: önizleme gizlendi',
  episode: 'S{s}:B{e} · {name}',
  pageTitle: 'Sırada ne var?',
  loading: 'Öneriler yükleniyor …',
  error: 'Öneriler yüklenemedi.',
  empty: 'Şu anda sana uygun bir önerimiz yok.',
  settings: {
    label: 'Son bölümden sonra öneriler göster',
    hint: 'Bir filmden ya da mevcut son bölümden sonra: sırada ne var, benzer yapımlar ve ipuçları. Hiçbir şey kendiliğinden başlamaz.',
  },
};
export default dict;
