import type { FeatureClient } from 'deveye-types/sdk/client';

import Osint from './Osint';
import OsintKeysPanel from './OsintKeysPanel';
import OsintWidget from './OsintWidget';

export const clientEntry: FeatureClient = {
    Widget: OsintWidget,
    Full: Osint,
    settingsPanels: { sources: OsintKeysPanel },
    // Démonté dès la fermeture, comme Git et Database : les cartes tiennent
    // des résultats lus chez des tiers, qui n'ont aucune raison de survivre
    // à la fermeture de l'écran — le cache TTL du serveur les resert de
    // toute façon instantanément si on rouvre.
    cacheDurationMinutes: 0,
    // L'historique est chiffré par mot de passe : garder la DEK vivante
    // pendant que l'écran est ouvert évite l'invite au milieu d'une session
    // de recherche.
    holdSecrecy: true
};
