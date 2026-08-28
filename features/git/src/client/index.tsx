import { GIT_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { FeatureClient } from '@deveye/types/sdk/client';

import CredentialsPanel from './CredentialsPanel';
import Git from './Git';
import GitWidget from './GitWidget';
import { clientProvider } from './provider';

export const clientEntry: FeatureClient = {
    Widget: GitWidget,
    Full: Git,
    /**
     * Le panneau Sources de la feature : les jetons GitHub de l'espace, que le
     * dialogue d'un dépôt ne fait que choisir. Partage et Permissions sont les
     * sections génériques de la coquille.
     */
    settingsPanels: { sources: CredentialsPanel },
    // Démonté dès la fermeture : la vue d'un dépôt sonde l'avancement d'une
    // synchronisation en cours, et une instance en cache continuerait de
    // sonder sans être vue. Pas de `holdSecrecy` : rien n'y est chiffré à
    // l'étage gardé, donc rien ne peut déclencher l'invite.
    cacheDurationMinutes: 0,
    /** Ce que Projets compose : la liste des dépôts, un dépôt relié en entier, le dialogue. */
    providers: { [GIT_CLIENT_PROVIDER]: clientProvider }
};
