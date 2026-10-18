// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/reco';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  because: '“{seed}” izlediğin için',
  picked: 'Senin için seçildi',
  trait: {
    friends: 'arkadaşların puanladı', friendsNamed: '{names} puanladı', next: 'insanlar bunu sonra izliyor', together: 'sık sık birlikte izleniyor', universe: 'aynı evren',
    director: 'aynı yönetmen', directorNamed: 'aynı yönetmen ({name})', actor: 'aynı oyuncular', actorNamed: '{name} ile',
    studioNamed: '{name} yapımı', genreNamed: 'tür: {name}',
  },
  why: { button: 'Bunu neden görüyorum?', heading: 'Neden bu yapımlar?', item: '{name}: {reason}', none: 'Zevkine uygun.', close: 'Gizle' },
  settings: {
    title: 'Öneriler',
    reset: 'Önerilerimi sıfırla',
    resetHint: 'Öğrenilen zevk profilini ve hangi satırlara tıkladığını unutur. Listen, puanların ve geçmişin kalır. Sonra öneriler geçmişinden yeniden oluşturulur.',
    resetDone: 'Sıfırlandı. Öneriler yeniden hesaplanıyor.',
    resetFailed: 'Sıfırlama başarısız oldu.',
    whyHint: 'Bir önerinin altındaki satıra (“… izlediğin için”) dokun; yapımın neden orada olduğunu görürsün.',
  },
  admin: {
    title: 'Öneri motoru',
    intro: 'Motor başına tıklama ve oynatma oranı, bu sunucunun sayaçlarından hesaplanır. Sayaçlar her yeniden başlatmada sıfırdan başlar.',
    active: 'Etkin: {engine}',
    engine: { v1: 'v1 (Jellyfin)', v2: 'v2 (kendi modelimiz)', shadow: 'Shadow (v2 yanında çalışır)' },
    col: { engine: 'Motor', shown: 'Gösterilen', clicks: 'Tıklanan', plays: 'Oynatılan', dismissed: 'Reddedilen', ctr: 'Tıklama oranı', playRate: 'Oynatma oranı' },
    fallbacks: 'v1’e geri dönüşler: {n}',
    since: '{date} tarihinden beri sayılıyor',
    empty: '–',
    loadFailed: 'Sayılar yüklenemedi.',
  },
};

export default dict;
