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
 * d'un appareil, sans état côté serveur. Infrastructure native de l'app ; un
 * module y accède par la capacité `agents`.
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
