import { DEPLOY_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { FeatureClient } from '@deveye/types/sdk/client';

import CredentialsPanel from './CredentialsPanel';
import Deploy from './Deploy';
import DeployWidget from './DeployWidget';
import { clientProvider } from './provider';
import TargetGeneralPanel from './TargetGeneralPanel';

export const clientEntry: FeatureClient = {
    Widget: DeployWidget,
    Full: Deploy,
    /** La cible elle-même (Général de sa fiche) ; les accès de l'espace, Dokploy et GitHub (Sources de la feature). */
    settingsPanels: { general: TargetGeneralPanel, sources: CredentialsPanel },
    // Démonté dès la fermeture : la fiche d'une cible suit un déploiement en vol,
    // et une instance en cache continuerait de le suivre sans être vue. Pas de
    // `holdSecrecy` : rien n'y est chiffré à l'étage gardé.
    cacheDurationMinutes: 0,
    /** Ce que Projets compose : la liste des cibles, une cible reliée en entier, le dialogue de déclaration. */
    providers: { [DEPLOY_CLIENT_PROVIDER]: clientProvider }
};
