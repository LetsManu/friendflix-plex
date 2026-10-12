import type de from '../de/mine';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  /** web app manifest (routes/manifest.webmanifest) */
  manifest: {
    description: 'Regardez films et séries ensemble',
    resumeDesc: 'Reprendre là où vous vous êtes arrêté',
  },
  calm: {
    title: 'Mode calme',
    hint: 'Rien ne démarre tout seul : pas de bande-annonce dans la bannière, pas d\'aperçu au survol, pas d\'aperçu automatique sur la fiche, pas de son – et moins d\'animations dans toute l\'application. S\'applique à ce profil.',
  },
  themed: {
    eyebrow: 'Liste thématique',
    mark: 'Présenter comme liste thématique',
    emoji: 'Icône (emoji)',
    emojiPlaceholder: 'p. ex. 🎃',
    color: 'Couleur de couverture',
    pin: 'Afficher sur l\'accueil',
    unpin: 'Retirer de l\'accueil',
    pinnedHint: 'Cette liste thématique est épinglée sur l\'accueil.',
    unfeatured: 'Cette liste était mise en avant. Son type (liste thématique) ayant changé, elle ne l\'est plus – un admin peut la remettre en avant.',
    tooManyPinned: 'Vous ne pouvez pas épingler plus de {max} listes.',
    manageTitle: 'Listes thématiques sur l\'accueil',
    manageHint: 'Les listes thématiques épinglées apparaissent sur l\'accueil de tout le monde, dans cet ordre ({max} au maximum, en comptant les listes mises en avant).',
    moveUp: 'Monter {name}',
    moveDown: 'Descendre {name}',
  },
};
export default dict;
