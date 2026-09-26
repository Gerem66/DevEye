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
     * À l'échelle de la feature, Général (devise, TVA) et Catégories, où les
     * fiches ne font que choisir. L'élément est le compte : son Général porte
     * son identité, son archivage et son retrait.
     */
    settings: {
        feature: ['general', { id: 'categories', label: 'Catégories', icon: 'folder' }],
        item: ['general']
    },
    commands: financeCommands
} satisfies FeatureManifest;
