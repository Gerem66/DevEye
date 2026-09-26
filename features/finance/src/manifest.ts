import { featureDescriptor } from '@deveye/types';

import { financeCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Le descriptif reste celui du registre publié ; le manifest n'ajoute que ce
 * que le registre ne porte pas.
 */
const descriptor = featureDescriptor('finance');

export const manifest = {
    ...descriptor,
    category: 'analysis',
    /**
     * Une écriture remue plusieurs vues à la fois ; le sujet `finance` les
     * ravive toutes ensemble, sinon deux écrans de la même donnée divergeraient.
     */
    resources: [
        'finance.summary',
        'finance.accountList',
        'finance.transactionList',
        'finance.recurringList',
        'finance.overview'
    ],
    /**
     * Un règlement saisi dans Facturation arrive dans le livre à la lecture
     * suivante : son sujet ravive donc ce qui montre de l'argent. Un membre qui
     * lit Finances sans lire Facturation ne reçoit pas ce battement, il verra
     * le règlement à sa prochaine lecture.
     */
    alsoInvalidatedBy: [
        {
            topic: 'invoicing',
            keys: ['finance.summary', 'finance.accountList', 'finance.transactionList', 'finance.overview']
        }
    ],
    /**
     * À l'échelle de la feature, Général (devise, TVA) et Catégories, où les
     * fiches ne font que choisir. L'élément est le compte : son Général porte
     * son identité, son archivage et son retrait.
     */
    settings: {
        feature: ['general', { id: 'categories', label: 'Catégories', icon: 'folder' }],
        item: ['general']
    },
    /** Les rappels de déclaration URSSAF partent par les canaux de l'espace. */
    nativeCapabilities: ['notify'],
    commands: financeCommands
} satisfies FeatureManifest;
