import type { FeatureDefinition } from './_define';
import { cloudSyncFeatures } from './cloudSync';
import { deviceFeatures } from './devices';
import { homeFeatures } from './home';
import { adminFeatures } from './admin';
import { liveHereFeature } from './live/here';
import { logsFeatures } from './logs';
import { mailFeatures } from './mail';
import { metricsFeatures } from './metrics';
import { noteFeatures } from './note';
import { databaseFeatures } from './database';
import { gitFeatures } from './git';
import { projectFeatures } from './project';
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
import { userSetColorFeature } from './user/setColor';
import { userSetThemeFeature } from './user/setTheme';
import { weatherFeatures } from './weather';
import { workspaceActivateFeature, workspaceSetFavoriteFeature } from './workspace/activate';
import {
    workspaceAddMemberFeature,
    workspaceLeaveFeature,
    workspaceRemoveMemberFeature,
    workspaceRenameFeature
} from './workspace/members';
import { workspaceEnableSharedKeyFeature, workspaceSharedKeyStatusFeature } from './workspace/sharedKey';
import {
    workspaceAssignRoleFeature,
    workspaceRoleCreateFeature,
    workspaceRoleDeleteFeature,
    workspaceRoleListFeature,
    workspaceRoleSetDefaultFeature,
    workspaceRoleUpdateFeature
} from './workspace/roles';
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
    workspaceAddMemberFeature,
    workspaceSharedKeyStatusFeature,
    workspaceEnableSharedKeyFeature,
    workspaceRoleListFeature,
    workspaceRoleCreateFeature,
    workspaceRoleUpdateFeature,
    workspaceRoleDeleteFeature,
    workspaceRoleSetDefaultFeature,
    workspaceAssignRoleFeature,
    userSetAvatarFeature,
    userSetThemeFeature,
    userSetColorFeature,
    passwordListFeature,
    passwordCountFeature,
    passwordGetFeature,
    passwordAddFeature,
    passwordEditFeature,
    passwordDeleteFeature,
    passwordUnlockFeature,
    ...noteFeatures,
    ...projectFeatures,
    ...gitFeatures,
    ...databaseFeatures,
    ...deviceFeatures,
    ...cloudSyncFeatures,
    ...metricsFeatures,
    ...twoFactorFeatures,
    ...secrecyFeatures,
    ...weatherFeatures,
    ...uptimeFeatures,
    ...logsFeatures,
    ...adminFeatures,
    ...homeFeatures,
    ...mailFeatures,
    liveHereFeature
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const featureHandlerMap: Record<string, FeatureDefinition<string, any, any>> = Object.fromEntries(
    featureHandlers.map((f) => [f.command, f])
);
