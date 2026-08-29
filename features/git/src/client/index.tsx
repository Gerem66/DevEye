import { GIT_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { FeatureClient } from '@deveye/types/sdk/client';

import CredentialsPanel from './CredentialsPanel';
import Git from './Git';
import GitWidget from './GitWidget';
import { clientProvider } from './provider';

export const clientEntry: FeatureClient = {
    Widget: GitWidget,
    Full: Git,
    /** Les jetons GitHub de l'espace, que le dialogue d'un dépôt ne fait que choisir. */
    settingsPanels: { sources: CredentialsPanel },
    // Démonté dès la fermeture : la vue d'un dépôt sonde l'avancement d'une
    // synchronisation, et une instance en cache continuerait de sonder sans être vue.
    cacheDurationMinutes: 0,
    /** Ce que Projets compose : la liste des dépôts, un dépôt relié en entier, le dialogue. */
    providers: { [GIT_CLIENT_PROVIDER]: clientProvider }
};
