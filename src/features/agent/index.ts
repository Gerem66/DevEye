import type { FeatureDefinition } from '../_define';
import {
    agentFilesAnalyzeFeature,
    agentFilesDownloadFeature,
    agentFilesListFeature,
    agentFilesMutateFeature,
    agentFilesSearchFeature,
    agentFilesUploadFeature
} from './files';
import { agentLifecycleFeature } from './lifecycle';
import { agentLogQueryFeature, agentLogSourcesFeature } from './logs';
import { agentListPackagesFeature, agentUpgradePackagesFeature } from './packages';
import { agentPowerFeature } from './power';
import { agentDropPrivilegesFeature, agentElevateFeature, agentSetAutostartFeature } from './service';
import { agentCollectFeature, agentSubscribeFeature, agentUnsubscribeFeature } from './subscription';
import { agentTermCloseFeature, agentTermInputFeature, agentTermOpenFeature, agentTermResizeFeature } from './terminal';
import { agentUpdateFeature } from './update';

/**
 * Le transport des agents (`agent.*`) : des relais du `MonitorHub` vers l'agent
 * d'un appareil, sans état côté serveur. C'est de l'infrastructure de l'app,
 * native ; la feature Appareils (`devices.*`, `../devices` et `../metrics`)
 * s'en sert, un module y accède par la capacité `agents`. Par souci :
 * - `subscription` : abonnement d'une socket aux poussées, collecte à la demande
 * - `power`        : ordres système (extinction, redémarrage, veille, verrouillage)
 * - `lifecycle`    : arrêt / redémarrage propre du processus de l'agent
 * - `service`      : persistance et privilèges (autostart, élévation, rétrogradation)
 * - `update`       : mise à jour signée poussée à l'agent
 * - `packages`     : détection des gestionnaires de paquets et mises à jour en direct
 * - `logs`         : lecture des journaux sur l'appareil (journald, Docker, fichiers)
 * - `terminal`     : sessions de shell distant (PTY)
 * - `files`        : explorateur de fichiers (listage, usage disque, recherche, mutations)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const agentFeatures: FeatureDefinition<string, any, any>[] = [
    agentSubscribeFeature,
    agentUnsubscribeFeature,
    agentCollectFeature,
    agentPowerFeature,
    agentLifecycleFeature,
    agentSetAutostartFeature,
    agentElevateFeature,
    agentDropPrivilegesFeature,
    agentUpdateFeature,
    agentListPackagesFeature,
    agentUpgradePackagesFeature,
    agentLogSourcesFeature,
    agentLogQueryFeature,
    agentTermOpenFeature,
    agentTermInputFeature,
    agentTermResizeFeature,
    agentTermCloseFeature,
    agentFilesListFeature,
    agentFilesAnalyzeFeature,
    agentFilesSearchFeature,
    agentFilesMutateFeature,
    agentFilesDownloadFeature,
    agentFilesUploadFeature
];
