import { featureDescriptor } from '@deveye/types';

import { devicesCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * Appareils, au format manifest : la seizième et dernière native rapatriée
 * sur le SDK, et la seule qui laisse une moitié d'elle-même à l'infrastructure.
 *
 * La coupure : le hub des agents, la socket agent, l'ingestion de la
 * télémétrie, la présence, l'enrôlement, la distribution des binaires et les
 * 23 commandes de transport (`agent.*` : fichiers, terminal, journaux,
 * paquets, alimentation, cycle de vie du processus, abonnement aux métriques)
 * sont l'app ; ce module est la FLOTTE (enrôler, confirmer, révoquer,
 * renommer, configurer la collecte, partager entre espaces, supprimer), les
 * MÉTRIQUES stockées et leur rétention, et tout l'écran de supervision. Il
 * parle au hub par la façade `agents` (trois ordres de cycle de vie, la
 * configuration poussée), aux appareils par les commandes de transport.
 *
 * Le descriptif (intitulé, icône, phrase des rôles, `hasItems`, `itemNoun`)
 * reste celui du registre publié, étalé plutôt que recopié.
 */
const descriptor = featureDescriptor('devices');

export const manifest = {
    ...descriptor,
    category: 'supervision',
    /**
     * Une clé de cache : la liste des appareils de l'espace, ravivée par le
     * sujet `devices` (une écriture de flotte, une arête de présence). Les
     * métriques ne se mettent pas en cache : un écran ouvert s'abonne au
     * flux (`agent.subscribe`) et relit l'historique à la demande.
     */
    resources: ['devices.list'],
    /**
     * `agents` : les ordres de cycle de vie et la configuration poussée ;
     * `devices.read` : la garde unique d'accès à un appareil
     * (`ctx.deveye.devices.authorize`, celle de `src/agent/authorize.ts`) ;
     * `workspaces.read` : rattacher un appareil aux espaces (administrateur).
     */
    nativeCapabilities: ['agents', 'devices.read', 'workspaces.read'],
    /** Le compteur d'appareils en ligne de la barre du haut. */
    topbarWidget: { description: "Nombre d'appareils en ligne" },
    /**
     * Général à l'échelle de la feature (les réglages du terminal, propres
     * au navigateur) et d'un appareil (la cadence de collecte, la capture des
     * processus, la rétention : l'ancien `ConfigDialog`, dernière dette de la
     * coquille de réglages).
     */
    settings: { feature: ['general'], item: ['general'] },
    commands: devicesCommands
} satisfies FeatureManifest;
