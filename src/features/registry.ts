import type { FeatureDefinition } from './_define';
import { deviceFeatures } from './devices';
import { metricsFeatures } from './metrics';
import {
    passwordAddFeature,
    passwordDeleteFeature,
    passwordEditFeature,
    passwordGetFeature,
    passwordListFeature,
    passwordUnlockFeature
} from './password';
import { secrecyFeatures } from './secrecy';
import { twoFactorFeatures } from './twofa';
import { userSetAvatarFeature } from './user/setAvatar';
import { weatherFeatures } from './weather';
import { workspaceAddFeature } from './workspace/add';
import { workspaceDeleteFeature } from './workspace/delete';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const featureHandlers: ReadonlyArray<FeatureDefinition<string, any, any>> = [
    workspaceAddFeature,
    workspaceDeleteFeature,
    userSetAvatarFeature,
    passwordListFeature,
    passwordGetFeature,
    passwordAddFeature,
    passwordEditFeature,
    passwordDeleteFeature,
    passwordUnlockFeature,
    ...deviceFeatures,
    ...metricsFeatures,
    ...twoFactorFeatures,
    ...secrecyFeatures,
    ...weatherFeatures
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const featureHandlerMap: Record<string, FeatureDefinition<string, any, any>> = Object.fromEntries(
    featureHandlers.map((f) => [f.command, f])
);
