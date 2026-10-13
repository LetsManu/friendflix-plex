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
};
export default dict;
