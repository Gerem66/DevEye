import type { FeatureClient } from '@deveye/types/sdk/client';

import Password from './Password';
import PasswordWidget from './PasswordWidget';

/** Pas de `settingsPanels` : le coffre n'a rien à régler. */
export const clientEntry: FeatureClient = {
    Widget: PasswordWidget,
    Full: Password,
    // Démonté dès la fermeture : la vue tient des entrées révélées en clair.
    cacheDurationMinutes: 0,
    // Garder la DEK vivante pendant que l'écran est ouvert évite l'invite au
    // milieu d'une saisie.
    holdSecrecy: true
};
