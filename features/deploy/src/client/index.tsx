import { DEPLOY_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { FeatureClient } from '@deveye/types/sdk/client';

import CredentialsPanel from './CredentialsPanel';
import Deploy from './Deploy';
import DeployWidget from './DeployWidget';
import { clientProvider } from './provider';

export const clientEntry: FeatureClient = {
    Widget: DeployWidget,
    Full: Deploy,
    /** Le panneau Sources : les accès Dokploy de l'espace, que le dialogue d'une cible ne fait que choisir. */
    settingsPanels: { sources: CredentialsPanel },
    // Démonté dès la fermeture : la fiche d'une cible suit un déploiement en vol,
    // et une instance en cache continuerait de le suivre sans être vue. Pas de
    // `holdSecrecy` : rien n'y est chiffré à l'étage gardé.
    cacheDurationMinutes: 0,
    /** Ce que Projets compose : la liste des cibles, une cible reliée en entier, le dialogue. */
    providers: { [DEPLOY_CLIENT_PROVIDER]: clientProvider }
};
