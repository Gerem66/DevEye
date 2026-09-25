import type { FeatureClient } from '@deveye/types/sdk/client';

import ProjectGeneralPanel from './ProjectGeneralPanel';
import ProjectHistoryPanel from './ProjectHistoryPanel';
import ProjectPublicPanel from './ProjectPublicPanel';
import Projects from './Projects';
import ProjectsWidget from './ProjectsWidget';

/**
 * Pas de `providers` : ce que Projets offre aux autres modules est un contrat
 * serveur.
 */
export const clientEntry: FeatureClient = {
    Widget: ProjectsWidget,
    Full: Projects,
    /** Le projet lui-même (Général), sa page publique, puis son histoire et ses archives (Historique). */
    settingsPanels: { general: ProjectGeneralPanel, public: ProjectPublicPanel, history: ProjectHistoryPanel },
    // Démonté à la fermeture : portefeuille, fils et présence vivent en
    // direct, une instance en cache continuerait de travailler sans être vue.
    cacheDurationMinutes: 0,
    // Un projet confidentiel est chiffré par mot de passe : garder la DEK
    // vivante tant que l'écran est ouvert évite l'invite au milieu d'une saisie.
    holdSecrecy: true
};
