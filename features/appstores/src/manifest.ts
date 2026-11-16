import { featureDescriptor } from '@deveye/types';

import { appStoresCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Le descripteur du registre porte l'identité de la feature ; le manifest
 * n'ajoute que ce qu'il ne porte pas. Son `shareTier: 'open'` engage l'entrée
 * `items` du serveur, `ctx.sharing.scope()` et `ctx.items.restrictions()`.
 */
const descriptor = featureDescriptor('appstores');

export const manifest = {
    ...descriptor,
    category: 'analysis',
    /**
     * Le sujet `appstores` les ravive toutes : après une écriture, et à chaque
     * passage du service qui a relevé quelque chose de neuf.
     */
    resources: [
        'appstores.count',
        'appstores.list',
        'appstores.detail',
        'appstores.stats',
        'appstores.revenue',
        'appstores.reviews',
        'appstores.sources'
    ],
    nativeCapabilities: ['notify'],
    quotas: [{ key: 'apps', label: 'apps suivies', stock: true }],
    /**
     * Les revenus sont une ressource de la fonctionnalité, comme les retours
     * d'Audience : ils ouvrent une section, sans autoriser un geste de plus.
     * Répondre aux avis reste un geste, donc sous l'écriture.
     */
    extraPermissions: [
        {
            key: 'revenue',
            label: 'Revenus',
            description:
                'Voir ce que rapportent les apps de cet espace : ventes, achats intégrés et abonnements, par ' +
                'store et par devise. Sans ce droit, le rôle voit les téléchargements, les notes et les avis, ' +
                'et la section Revenus reste fermée.',
            type: 'toggle'
        }
    ],
    /**
     * Les comptes de store dans l'onglet Sources de la feature ; l'app elle-même
     * (nom, fiches de store, pays de la note, suppression) dans l'onglet Général
     * de sa fiche. Partage et Permissions viennent du descripteur.
     */
    settings: { feature: ['sources'], item: ['general'] },
    commands: appStoresCommands
} satisfies FeatureManifest;
