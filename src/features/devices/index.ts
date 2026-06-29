import type { FeatureDefinition } from '../_define';
import { deviceUpdateAgentFeature } from './agentUpdate';
import {
    deviceCancelDeleteFeature,
    deviceConfirmFeature,
    deviceDeleteFeature,
    deviceForceDeleteFeature,
    deviceListFeature,
    deviceReactivateFeature,
    deviceRenameFeature,
    deviceRequestDeleteFeature,
    deviceRevokeFeature,
    deviceSetConfigFeature
} from './lifecycle';
import {
    deviceFilesAnalyzeFeature,
    deviceFilesListFeature,
    deviceFilesMutateFeature,
    deviceFilesSearchFeature
} from './files';
import { deviceLogQueryFeature, deviceLogSourcesFeature } from './logs';
import { deviceListPackagesFeature, deviceUpgradePackagesFeature } from './packages';
import { devicePowerFeature } from './power';
import {
    deviceTermCloseFeature,
    deviceTermInputFeature,
    deviceTermOpenFeature,
    deviceTermResizeFeature
} from './terminal';
import { deviceDropPrivilegesFeature, deviceElevateFeature, deviceSetAutostartFeature } from './service';

/**
 * The device (Appareils + Monitoring) feature handlers, grouped by concern:
 * - `lifecycle`  — enrollment/status (list, confirm, revoke, rename, delete…)
 * - `agentUpdate` — signed self-update push
 * - `service`    — persistence/privileges (autostart, elevate, drop)
 * - `packages`   — update-manager detection + live upgrades
 * - `power`      — system power actions (shutdown, reboot, suspend, lock…)
 * - `logs`       — on-device log viewer (journald, Docker, files…)
 * - `terminal`   — interactive remote shell (PTY) sessions
 * - `files`      — file explorer (list, usage analysis, search, mutations)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const deviceFeatures: FeatureDefinition<string, any, any>[] = [
    deviceListFeature,
    deviceConfirmFeature,
    deviceRevokeFeature,
    deviceReactivateFeature,
    deviceRenameFeature,
    deviceSetConfigFeature,
    deviceUpdateAgentFeature,
    deviceSetAutostartFeature,
    deviceElevateFeature,
    deviceDropPrivilegesFeature,
    deviceListPackagesFeature,
    deviceUpgradePackagesFeature,
    devicePowerFeature,
    deviceLogSourcesFeature,
    deviceLogQueryFeature,
    deviceTermOpenFeature,
    deviceTermInputFeature,
    deviceTermResizeFeature,
    deviceTermCloseFeature,
    deviceFilesListFeature,
    deviceFilesAnalyzeFeature,
    deviceFilesSearchFeature,
    deviceFilesMutateFeature,
    deviceRequestDeleteFeature,
    deviceCancelDeleteFeature,
    deviceForceDeleteFeature,
    deviceDeleteFeature
];
