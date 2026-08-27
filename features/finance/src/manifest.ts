import { featureDescriptor } from '@deveye/types';

import { financeCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Finances, au format manifest : la troisième native rapatriée sur le SDK.
 *
 * Le descriptif (intitulé, icône, phrase des rôles) reste celui du registre
 * publié, étalé plutôt que recopié : une native garde son identité dans
 * @deveye/types, le manifest n'ajoute que ce que le registre ne porte pas
 * (catégorie, onglets de réglages, ressources, commandes).
 */
const descriptor = featureDescriptor('finance');

export const manifest = {
    ...descriptor,
    category: 'analysis',
    /**
     * Six clés, parce qu'une écriture des finances remue plusieurs vues à la
     * fois (une dépense change le journal, un solde, un budget, la frise du
     * tableau de bord et la carte de l'accueil) et que chacune de ces vues n'a
     * aucune raison de relire les cinq autres. Le sujet `finance` les ravive
     * toutes ensemble : n'en invalider qu'une partie ferait diverger deux
     * écrans de la même donnée à la même seconde, chez la même personne. Sur
     * un livre de comptes, cela se lit comme une erreur de calcul et non comme
     * un retard d'affichage. Le sujet bat aussi quand le rattrapage des
     * échéances écrit tout seul (`postDueRecurring`, en tête de chaque
     * lecture) : c'est ce qui fait apparaître un loyer prélevé sans que
     * personne n'ait rien saisi.
     */
    resources: [
        'finance.summary',
        'finance.accountList',
        'finance.transactionList',
        'finance.budgetList',
        'finance.recurringList',
        'finance.overview'
    ],
    /**
     * Deux panneaux dans la coquille commune, derrière le bouton de réglages
     * de l'en-tête : Général (devise, mode entreprise) et Catégories (la
     * grille de lecture des dépenses et des recettes). C'est ce qui a remplacé
     * les deux dialogues artisanaux de l'ancien engrenage : les catégories se
     * gèrent ici, les fiches d'opération ne font que choisir dedans, patron
     * des sources.
     */
    settings: { feature: ['general', { id: 'categories', label: 'Catégories', icon: 'folder' }] },
    commands: financeCommands
} satisfies FeatureManifest;
