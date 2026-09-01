import { featureDescriptor } from '@deveye/types';

import { devicesCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Appareils, au format manifest. La coupure avec l'infrastructure : le hub des
 * agents, la socket agent, l'ingestion, la présence, l'enrôlement, la
 * distribution des binaires et les commandes de transport `agent.*` sont l'app ;
 * ce module est la flotte, les métriques stockées et leur rétention, et l'écran
 * de supervision. Il parle au hub par la façade `agents`.
 *
 * Le descriptif (intitulé, icône, rôles, `hasItems`, `itemNoun`) vient du
 * registre publié, étalé plutôt que recopié.
 */
const descriptor = featureDescriptor('devices');

export const manifest = {
    ...descriptor,
    category: 'supervision',
    /**
     * La liste des appareils de l'espace, ravivée par le sujet `devices` (une
     * écriture de flotte, une arête de présence). Les métriques ne se mettent
     * pas en cache : un écran ouvert s'abonne au flux.
     */
    resources: ['devices.list'],
    /**
     * `agents` : les ordres de cycle de vie et la configuration poussée ;
     * `devices.read` : la garde unique d'accès à un appareil
     * (`ctx.deveye.devices.authorize`).
     */
    nativeCapabilities: ['agents', 'devices.read'],
    /** Le compteur d'appareils en ligne de la barre du haut. */
    topbarWidget: { description: "Nombre d'appareils en ligne" },
    /**
     * Tout se règle appareil par appareil : ce que son agent collecte, et
     * comment son terminal s'ouvre. La fonctionnalité n'a aucun réglage
     * commun, donc aucun onglet et aucun bouton. Le partage et les permissions
     * d'un appareil viennent de la coquille, sans être déclarés ici.
     */
    settings: {
        item: [
            { id: 'collect', label: 'Collecte', icon: 'activity' },
            { id: 'terminal', label: 'Terminal', icon: 'terminal' }
        ]
    },
    /**
     * Piloter une machine et gérer la flotte sont deux choses : `read`/`write`
     * gouvernent la liste (voir, appairer, approuver, renommer, révoquer,
     * régler), ces quatre-là gouvernent ce qu'on fait DE la machine. Elles
     * n'en découlent pas : un gestionnaire de parc n'a pas besoin d'un shell
     * root, et un support en a besoin sans pouvoir révoquer quoi que ce soit.
     * Chacune exige la lecture, et la restriction par élément s'applique
     * par-dessus.
     */
    extraPermissions: [
        {
            key: 'terminal',
            label: 'Terminal distant',
            description:
                'Ouvrir un shell sur les appareils de l’espace, sous le compte réglé pour chacun. Le droit le plus lourd de la fonctionnalité.',
            type: 'toggle'
        },
        {
            key: 'files',
            label: 'Explorateur de fichiers',
            description: 'Parcourir, lire, téléverser, renommer et supprimer les fichiers des appareils de l’espace.',
            type: 'toggle'
        },
        {
            key: 'logs',
            label: 'Logs de l’appareil',
            description: 'Lire les journaux système des appareils de l’espace.',
            type: 'toggle'
        },
        {
            key: 'system',
            label: 'Commandes et mises à jour système',
            description:
                'Verrouiller, mettre en veille, redémarrer ou éteindre un appareil, et appliquer ses mises à jour de paquets.',
            type: 'toggle'
        }
    ],
    commands: devicesCommands
} satisfies FeatureManifest;
