import type { ZodType } from 'zod';

import type { SdkFeatureDefinition } from '@deveye/types/sdk/server';

import {
    devicesCancelDeleteFeature,
    devicesConfirmFeature,
    devicesDeleteFeature,
    devicesForceDeleteFeature,
    devicesListFeature,
    devicesReactivateFeature,
    devicesRenameFeature,
    devicesReorderFeature,
    devicesRequestDeleteFeature,
    devicesRevokeFeature,
    devicesSetConfigFeature,
    devicesSetWorkspacesFeature,
    devicesWorkspaceListFeature
} from './fleet';
import {
    devicesAvailabilityFeature,
    devicesDeleteSnapshotsFeature,
    devicesMetricsFeature,
    devicesPresenceFeature,
    devicesProcessesAtFeature,
    devicesSetSnapshotsPinnedFeature,
    devicesSnapshotsFeature,
    devicesStorageFeature
} from './history';
import {
    devicesLinkCodeCreateFeature,
    devicesLinkCodeListFeature,
    devicesLinkCodeRevokeFeature,
    devicesLinkCodeSetAutoApproveFeature
} from './linkCodes';
import type { DevicesRepo } from './repo';

/** Les commandes du module, dans le même ordre que `devicesCommands` : les deux listes se comparent. */
export const devicesHandlers: readonly SdkFeatureDefinition<DevicesRepo, string, ZodType, ZodType>[] = [
    devicesListFeature,
    devicesConfirmFeature,
    devicesRevokeFeature,
    devicesReactivateFeature,
    devicesRenameFeature,
    devicesReorderFeature,
    devicesSetConfigFeature,
    devicesWorkspaceListFeature,
    devicesSetWorkspacesFeature,
    devicesRequestDeleteFeature,
    devicesCancelDeleteFeature,
    devicesForceDeleteFeature,
    devicesDeleteFeature,
    devicesMetricsFeature,
    devicesPresenceFeature,
    devicesProcessesAtFeature,
    devicesAvailabilityFeature,
    devicesSnapshotsFeature,
    devicesStorageFeature,
    devicesDeleteSnapshotsFeature,
    devicesSetSnapshotsPinnedFeature,
    devicesLinkCodeCreateFeature,
    devicesLinkCodeListFeature,
    devicesLinkCodeSetAutoApproveFeature,
    devicesLinkCodeRevokeFeature
];
