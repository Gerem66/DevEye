import { featureDescriptor } from '@deveye/types';

import { weatherCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Météo, au format manifest : la première native rapatriée sur le SDK.
 *
 * Le descriptif (intitulé, icône, sources) reste celui du registre publié,
 * étalé plutôt que recopié : une native garde son identité dans @deveye/types,
 * le manifest n'ajoute que ce que le registre ne porte pas (catégorie, onglets,
 * ressources, permissions déclarées, commandes).
 */
const descriptor = featureDescriptor('weather');

export const manifest = {
    ...descriptor,
    category: 'daily',
    /**
     * Une seule clé de cache : la liste des lieux. Les relevés (`weather.get`)
     * ne se mettent pas en cache par le bus, ils se relisent à la demande et au
     * rythme du rafraîchissement de la vue.
     */
    resources: ['weather.list'],
    /** Le mini-widget de topbar : la température de la ville principale. */
    topbarWidget: { description: 'Température de la ville principale' },
    settings: { feature: ['sources'] },
    /**
     * La démonstration des permissions déclarées : gérer les clés d'API des
     * fournisseurs se confie séparément de l'écriture (ajouter une ville ne
     * devrait pas donner la main sur des secrets d'espace). Le propriétaire
     * l'a d'office, comme tout extra.
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
