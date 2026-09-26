import type { FeatureClient } from '@deveye/types/sdk/client';

import Osint from './Osint';
import OsintProbesPanel from './OsintProbesPanel';
import OsintWidget from './OsintWidget';

export const clientEntry: FeatureClient = {
    Widget: OsintWidget,
    Full: Osint,
    settingsPanels: { probes: OsintProbesPanel },
    // Démonté dès la fermeture : les cartes tiennent des résultats lus chez des
    // tiers, et le cache TTL du serveur les resert si on rouvre.
    cacheDurationMinutes: 0,
    // L'historique est chiffré par mot de passe : garder la DEK vivante évite
    // l'invite au milieu d'une session de recherche.
    holdSecrecy: true
};
