import type { FeatureDefinition } from './_define';
import { deviceFeatures } from './devices';
import { homeFeatures } from './home';
import { logsFeatures } from './logs';
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
import { userSetAvatarFeature } from './user/setAvatar';
import { userSetThemeFeature } from './user/setTheme';
import { weatherFeatures } from './weather';
import { workspaceAddFeature } from './workspace/add';
import { workspaceDeleteFeature } from './workspace/delete';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const featureHandlers: ReadonlyArray<FeatureDefinition<string, any, any>> = [
    workspaceAddFeature,
    workspaceDeleteFeature,
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
    ...metricsFeatures,
    ...twoFactorFeatures,
    ...secrecyFeatures,
    ...weatherFeatures,
    ...logsFeatures,
    ...homeFeatures
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const featureHandlerMap: Record<string, FeatureDefinition<string, any, any>> = Object.fromEntries(
    featureHandlers.map((f) => [f.command, f])
);
