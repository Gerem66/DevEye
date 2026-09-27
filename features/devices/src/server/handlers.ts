import type { ZodType } from 'zod';

import type { SdkFeatureDefinition } from '@deveye/types/sdk/server';

import {
    devicesCancelDeleteFeature,
    devicesConfirmFeature,
    devicesDeleteFeature,
    devicesForceDeleteFeature,
    devicesListFeature,
    devicesRenameFeature,
    devicesReorderFeature,
    devicesRequestDeleteFeature,
    devicesRevokeFeature,
    devicesSetConfigFeature
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
import { devicesLinkCodeCreateFeature, devicesLinkCodeListFeature, devicesLinkCodeRevokeFeature } from './linkCodes';
import type { DevicesRepo } from './repo';

/** Les commandes du module, dans le même ordre que `devicesCommands` : les deux listes se comparent. */
export const devicesHandlers: readonly SdkFeatureDefinition<DevicesRepo, string, ZodType, ZodType>[] = [
    devicesListFeature,
    devicesConfirmFeature,
    devicesRevokeFeature,
    devicesRenameFeature,
    devicesReorderFeature,
    devicesSetConfigFeature,
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
    devicesLinkCodeRevokeFeature
];
