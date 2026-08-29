import type { FeatureClient } from '@deveye/types/sdk/client';

import Notes from './Notes';
import NotesWidget from './NotesWidget';

/**
 * Pas de `settingsPanels` : la configuration des notes se fait à l'échelle d'une
 * note, depuis son éditeur (Partage, Permissions).
 */
export const clientEntry: FeatureClient = {
    Widget: NotesWidget,
    Full: Notes,
    // La vue tient des titres et aperçus déchiffrés : rien ne doit survivre à la
    // fermeture de l'écran.
    cacheDurationMinutes: 0,
    // Notes privées chiffrées par mot de passe : garder la DEK vivante pendant que
    // l'écran est ouvert évite l'invite au milieu d'une saisie.
    holdSecrecy: true
};
