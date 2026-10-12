import type de from '../de/mine';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  /** web app manifest (routes/manifest.webmanifest) */
  manifest: {
    description: 'Film ve dizileri birlikte izleyin',
    resumeDesc: 'Kaldığınız yerden devam edin',
  },
  calm: {
    title: 'Sakin mod',
    hint: 'Hiçbir şey kendiliğinden başlamaz: ana bannerda fragman, üzerine gelince önizleme, ayrıntı sayfasında otomatik önizleme ve ses yoktur – tüm uygulamada hareket de azalır. Bu profil için geçerlidir.',
  },
  themed: {
    eyebrow: 'Tema listesi',
    mark: 'Tema listesi olarak düzenle',
    emoji: 'Simge (emoji)',
    emojiPlaceholder: 'örn. 🎃',
    color: 'Kapak rengi',
    pin: 'Ana sayfada göster',
    unpin: 'Ana sayfadan kaldır',
    pinnedHint: 'Bu tema listesi ana sayfaya sabitlendi.',
    unfeatured: 'Bu liste öne çıkarılmıştı. Türü (tema listesi) değiştiği için artık öne çıkarılmıyor – bir yönetici yeniden öne çıkarabilir.',
    tooManyPinned: 'En fazla {max} liste sabitlenebilir.',
    manageTitle: 'Ana sayfadaki tema listeleri',
    manageHint: 'Sabitlenen tema listeleri herkesin ana sayfasında bu sırayla görünür (öne çıkan listelerle birlikte en fazla {max}).',
    moveUp: '{name} listesini yukarı taşı',
    moveDown: '{name} listesini aşağı taşı',
  },
};
export default dict;
