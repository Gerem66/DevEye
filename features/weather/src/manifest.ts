import { featureDescriptor } from '@deveye/types';

import { weatherCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/** Le descriptif vient du registre publié ; le manifest n'ajoute que ce que le registre ne porte pas. */
const descriptor = featureDescriptor('weather');

export const manifest = {
    ...descriptor,
    category: 'daily',
    /**
     * La liste des lieux et l'état des clés de l'espace, qui ouvre le choix de
     * source dans la fiche. Les relevés (`weather.get`) se relisent à la
     * demande, au rythme du rafraîchissement de la vue.
     */
    resources: ['weather.list', 'weather.keyList'],
    topbarWidget: { description: 'Température de la ville principale' },
    settings: { feature: ['sources'] },
    /**
     * Gérer les clés d'API se confie séparément de l'écriture : ajouter une ville
     * ne doit pas donner la main sur des secrets d'espace.
     */
    extraPermissions: [
        {
            key: 'manageKeys',
            label: 'Gérer les clés d’API',
            description:
                'Enregistrer et supprimer les clés d’API des fournisseurs météo de l’espace. Sans ce droit, l’écriture permet toujours d’ajouter et de régler des villes.',
            type: 'toggle'
        }
    ],
    commands: weatherCommands
} satisfies FeatureManifest;
