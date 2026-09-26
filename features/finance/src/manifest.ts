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
        'finance.overview',
        'finance.statementList',
        'finance.ruleList',
        'finance.connectionList'
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
            keys: [
                'finance.summary',
                'finance.accountList',
                'finance.transactionList',
                'finance.overview',
                'finance.statementList'
            ]
        }
    ],
    /**
     * À l'échelle de la feature, le statut, les connexions bancaires (Sources),
     * les catégories et les règles qui rangent les lignes de relevé. L'élément
     * est le compte : son Général porte son identité, son archivage et son
     * retrait, sa Banque la connexion qui l'alimente.
     */
    settings: {
        feature: [
            'general',
            'sources',
            { id: 'categories', label: 'Catégories', icon: 'folder' },
            { id: 'rules', label: 'Règles', icon: 'list' }
        ],
        item: ['general', { id: 'bank', label: 'Banque', icon: 'refresh' }]
    },
    /**
     * Une connexion bancaire interroge sa banque toutes les six heures, à vie :
     * un stock, dont l'excédent se met en pause. L'import de relevé, lui, ne
     * coûte rien de récurrent et reste sans limite.
     */
    quotas: [{ key: 'bankConnections', label: 'connexions bancaires', stock: true }],
    /**
     * Les rappels (déclarations, consentements bancaires) partent par les canaux
     * de l'espace ; la banque revient sur une route à ticket après le consentement.
     */
    nativeCapabilities: ['notify', 'routes.public'],
    commands: financeCommands
} satisfies FeatureManifest;
