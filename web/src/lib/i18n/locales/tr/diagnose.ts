// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/diagnose';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Ekran tanılama',
  hint: 'Bu cihazın görüntüleme alanına ait ölçümler (pencere, güvenli alanlar, sekme çubuğu). Ekran görüntüsü alın veya değerleri kopyalayın.',
  copy: 'Değerleri kopyala',
  copied: 'Kopyalandı.',
  copyFailed: 'Kopyalanamadı, lütfen metni seçin.',
  airplayTitle: 'AirPlay günlüğü',
  airplayHint: 'Bu cihazdaki son AirPlay olayları (adres ve token olmadan). Bir sorun bildirirken kopyalayıp ekleyin.',
  airplayCopy: 'Kopyala',
  airplayClear: 'Temizle',
  airplayEmpty: 'Henüz kayıt yok.',
  timingTitle: 'Başlatma süreleri',
  timingHint: 'Bu cihazdaki son oynatmalar: bilgi, çalma listesi, ilk parça ve ilk karenin ne kadar sürdüğü, ayrıca sarmalar ve takılmalar.',
  timingEmpty: 'Bu cihazda henüz ölçüm yok.',
};
export default dict;
