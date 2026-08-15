import type { FeatureDefinition } from '../_define';
import {
    cloudSyncBrowseFeature,
    cloudSyncPauseShareFeature,
    cloudSyncResumeShareFeature,
    cloudSyncSubscribeFeature,
    cloudSyncSyncNowFeature,
    cloudSyncUnsubscribeFeature
} from './control';
import {
    cloudSyncAttachDeviceFeature,
    cloudSyncDetachDeviceFeature,
    cloudSyncPauseDeviceFeature,
    cloudSyncResumeDeviceFeature
} from './devices';
import { cloudSyncListEventsFeature } from './events';
import { cloudSyncAddExclusionFeature, cloudSyncRemoveExclusionFeature } from './exclusions';
import {
    cloudSyncCreateShareFeature,
    cloudSyncDeleteShareFeature,
    cloudSyncListSharesFeature,
    cloudSyncUpdateShareFeature,
    cloudSyncValidatePathFeature
} from './shares';
import {
    cloudSyncCreateSnapshotFeature,
    cloudSyncDeleteSnapshotFeature,
    cloudSyncDiffSnapshotFeature,
    cloudSyncListSnapshotsFeature,
    cloudSyncRestoreSnapshotFeature,
    cloudSyncVerifyIntegrityFeature
} from './snapshots';
import {
    cloudSyncClearVersionsFeature,
    cloudSyncDeleteVersionFeature,
    cloudSyncDeleteVersionsFeature,
    cloudSyncDownloadFileFeature,
    cloudSyncDownloadVersionFeature,
    cloudSyncListVersionsFeature,
    cloudSyncRestoreVersionFeature
} from './versions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const cloudSyncFeatures: ReadonlyArray<FeatureDefinition<string, any, any>> = [
    cloudSyncListSharesFeature,
    cloudSyncValidatePathFeature,
    cloudSyncCreateShareFeature,
    cloudSyncUpdateShareFeature,
    cloudSyncDeleteShareFeature,
    cloudSyncAttachDeviceFeature,
    cloudSyncDetachDeviceFeature,
    cloudSyncPauseShareFeature,
    cloudSyncResumeShareFeature,
    cloudSyncPauseDeviceFeature,
    cloudSyncResumeDeviceFeature,
    cloudSyncAddExclusionFeature,
    cloudSyncRemoveExclusionFeature,
    cloudSyncSyncNowFeature,
    cloudSyncSubscribeFeature,
    cloudSyncUnsubscribeFeature,
    cloudSyncBrowseFeature,
    cloudSyncListEventsFeature,
    cloudSyncListVersionsFeature,
    cloudSyncRestoreVersionFeature,
    cloudSyncDeleteVersionFeature,
    cloudSyncDeleteVersionsFeature,
    cloudSyncClearVersionsFeature,
    cloudSyncDownloadVersionFeature,
    cloudSyncDownloadFileFeature,
    cloudSyncListSnapshotsFeature,
    cloudSyncCreateSnapshotFeature,
    cloudSyncDiffSnapshotFeature,
    cloudSyncRestoreSnapshotFeature,
    cloudSyncDeleteSnapshotFeature,
    cloudSyncVerifyIntegrityFeature
];
