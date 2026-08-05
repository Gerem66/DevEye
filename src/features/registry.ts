import type { FeatureDefinition } from './_define';
import { cloudSyncFeatures } from './cloudSync';
import { deviceFeatures } from './devices';
import { homeFeatures } from './home';
import { logsFeatures } from './logs';
import { mailFeatures } from './mail';
import { metricsFeatures } from './metrics';
import { noteFeatures } from './note';
import {
    passwordAddFeature,
    passwordCountFeature,
    passwordDeleteFeature,
    passwordEditFeature,
    passwordGetFeature,
    passwordListFeature,
    passwordUnlockFeature
} from './password';
import { secrecyFeatures } from './secrecy';
import { twoFactorFeatures } from './twofa';
import { uptimeFeatures } from './uptime';
import { userSetAvatarFeature } from './user/setAvatar';
import { userSetThemeFeature } from './user/setTheme';
import { weatherFeatures } from './weather';
import { workspaceActivateFeature, workspaceSetFavoriteFeature } from './workspace/activate';
import {
    workspaceInviteAcceptFeature,
    workspaceInviteCreateFeature,
    workspaceInviteListFeature,
    workspaceInvitePreviewFeature,
    workspaceInviteRevokeFeature,
    workspaceLeaveFeature,
    workspaceRemoveMemberFeature,
    workspaceRenameFeature
} from './workspace/members';
import { workspaceAddFeature } from './workspace/add';
import { workspaceDeleteFeature } from './workspace/delete';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const featureHandlers: ReadonlyArray<FeatureDefinition<string, any, any>> = [
    workspaceAddFeature,
    workspaceDeleteFeature,
    workspaceActivateFeature,
    workspaceSetFavoriteFeature,
    workspaceRenameFeature,
    workspaceLeaveFeature,
    workspaceRemoveMemberFeature,
    workspaceInviteCreateFeature,
    workspaceInviteListFeature,
    workspaceInviteRevokeFeature,
    workspaceInvitePreviewFeature,
    workspaceInviteAcceptFeature,
    userSetAvatarFeature,
    userSetThemeFeature,
    passwordListFeature,
    passwordCountFeature,
    passwordGetFeature,
    passwordAddFeature,
    passwordEditFeature,
    passwordDeleteFeature,
    passwordUnlockFeature,
    ...noteFeatures,
    ...deviceFeatures,
    ...cloudSyncFeatures,
    ...metricsFeatures,
    ...twoFactorFeatures,
    ...secrecyFeatures,
    ...weatherFeatures,
    ...uptimeFeatures,
    ...logsFeatures,
    ...homeFeatures,
    ...mailFeatures
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const featureHandlerMap: Record<string, FeatureDefinition<string, any, any>> = Object.fromEntries(
    featureHandlers.map((f) => [f.command, f])
);
