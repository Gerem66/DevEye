import type { FeatureClient } from '@deveye/types/sdk/client';

import Password from './Password';
import PasswordWidget from './PasswordWidget';

/**
 * Pas de `settingsPanels` : le coffre n'a rien à régler, et son manifest ne
 * déclare aucun onglet. Le bouton commun de réglages n'est donc pas monté.
 */
export const clientEntry: FeatureClient = {
    Widget: PasswordWidget,
    Full: Password,
    // Démonté dès la fermeture : la vue tient des entrées dont certaines ont
    // pu être révélées en clair, qui n'ont aucune raison de survivre à la
    // fermeture de l'écran ; elle relit la liste à l'ouverture de toute façon.
    cacheDurationMinutes: 0,
    // Tout le coffre est chiffré par mot de passe : garder la DEK vivante
    // pendant que l'écran est ouvert évite l'invite au milieu d'une saisie
    // (voir `holdSecrecy` de WidgetPopup).
    holdSecrecy: true
};
