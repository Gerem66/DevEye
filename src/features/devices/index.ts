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
import { deviceListPackagesFeature, deviceUpgradePackagesFeature } from './packages';
import { deviceDropPrivilegesFeature, deviceElevateFeature, deviceSetAutostartFeature } from './service';

/**
 * The device (Appareils + Monitoring) feature handlers, grouped by concern:
 * - `lifecycle`  — enrollment/status (list, confirm, revoke, rename, delete…)
 * - `agentUpdate` — signed self-update push
 * - `service`    — persistence/privileges (autostart, elevate, drop)
 * - `packages`   — update-manager detection + live upgrades
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
    deviceRequestDeleteFeature,
    deviceCancelDeleteFeature,
    deviceForceDeleteFeature,
    deviceDeleteFeature
];
