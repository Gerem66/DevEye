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
        'finance.budgetList',
        'finance.recurringList',
        'finance.overview'
    ],
    /** Général (devise, mode entreprise) et Catégories ; les fiches ne font que choisir dedans. */
    settings: { feature: ['general', { id: 'categories', label: 'Catégories', icon: 'folder' }] },
    commands: financeCommands
} satisfies FeatureManifest;
