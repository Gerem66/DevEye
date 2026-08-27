import type { FeatureClient } from '@deveye/types/sdk/client';

import Notes from './Notes';
import NotesWidget from './NotesWidget';

/**
 * Pas de `settingsPanels` : les notes n'ont rien à régler, et leur manifest
 * ne déclare aucun onglet. Le bouton commun de réglages n'est donc pas monté.
 */
export const clientEntry: FeatureClient = {
    Widget: NotesWidget,
    Full: Notes,
    // Démonté dès la fermeture : la vue tient des notes dont certaines ont pu
    // être déchiffrées (titres et aperçus des notes privées), qui n'ont aucune
    // raison de survivre à la fermeture de l'écran ; elle relit la liste à
    // l'ouverture de toute façon.
    cacheDurationMinutes: 0,
    // Les notes privées sont chiffrées par mot de passe : garder la DEK vivante
    // pendant que l'écran est ouvert évite l'invite au milieu d'une saisie
    // (voir `holdSecrecy` de WidgetPopup).
    holdSecrecy: true
};
