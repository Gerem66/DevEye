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
     * Rien de commun entre les deux échelles : la feature règle le terminal
     * (propre au navigateur), un appareil règle ce que son agent collecte. Le
     * partage et les permissions d'un appareil viennent de la coquille, sans
     * être déclarés ici.
     */
    settings: {
        feature: [{ id: 'terminal', label: 'Terminal', icon: 'terminal' }],
        item: [{ id: 'collect', label: 'Collecte', icon: 'activity' }]
    },
    commands: devicesCommands
} satisfies FeatureManifest;
