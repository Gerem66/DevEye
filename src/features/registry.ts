import type { FeatureDefinition } from './_define';
import { agentFeatures } from './agent';
import { feedbackFeatures } from './feedback';
import { homeFeatures } from './home';
import { adminFeatures } from './admin';
import { debugFeatures } from './debug';
import { liveHereFeature } from './live/here';
import { logsFeatures } from './logs';
import { notifyFeatures } from './notify';
import { domainFeatures } from './domain';
import { sharingFeatures } from './sharing';
import { secrecyFeatures } from './secrecy';
import { twoFactorFeatures } from './twofa';
import { userDeleteAccountFeature } from './user/deleteAccount';
import { userSetAvatarFeature } from './user/setAvatar';
import { userPlanFeature } from './user/plan';
import { userSetColorFeature } from './user/setColor';
import { userSetSettingFeature } from './user/setSetting';
import { userSetUsernameFeature } from './user/setUsername';
import { userSetThemeFeature } from './user/setTheme';
import { workspaceActivateFeature, workspaceSetFavoriteFeature } from './workspace/activate';
import {
    workspaceAddMemberFeature,
    workspaceLeaveFeature,
    workspaceRemoveMemberFeature,
    workspaceRenameFeature
} from './workspace/members';
import {
    workspaceAssignRoleFeature,
    workspaceRoleCreateFeature,
    workspaceRoleDeleteFeature,
    workspaceRoleListFeature,
    workspaceRoleSetDefaultFeature,
    workspaceRoleUpdateFeature
} from './workspace/roles';
import { remoteFeatures } from './remote';
import { workspaceAddFeature } from './workspace/add';
import { workspaceDeleteFeature } from './workspace/delete';
import { INSTALLED_MODULES } from './_generated/installed';
import { moduleFeatureHandlers, registerModules } from './_sdk/register';

// Les modules installés s'enregistrent au chargement du registre ; une
// violation lève ici, avant même les sentinelles du boot.
registerModules(INSTALLED_MODULES);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const featureHandlers: ReadonlyArray<FeatureDefinition<string, any, any>> = [
    ...moduleFeatureHandlers(),
    workspaceAddFeature,
    workspaceDeleteFeature,
    workspaceActivateFeature,
    workspaceSetFavoriteFeature,
    workspaceRenameFeature,
    workspaceLeaveFeature,
    workspaceRemoveMemberFeature,
    workspaceAddMemberFeature,
    workspaceRoleListFeature,
    workspaceRoleCreateFeature,
    workspaceRoleUpdateFeature,
    workspaceRoleDeleteFeature,
    workspaceRoleSetDefaultFeature,
    workspaceAssignRoleFeature,
    ...remoteFeatures,
    userSetAvatarFeature,
    userSetThemeFeature,
    userPlanFeature,
    userSetColorFeature,
    userSetSettingFeature,
    userSetUsernameFeature,
    userDeleteAccountFeature,
    ...agentFeatures,
    ...twoFactorFeatures,
    ...secrecyFeatures,
    ...logsFeatures,
    ...feedbackFeatures,
    ...adminFeatures,
    ...debugFeatures,
    ...homeFeatures,
    ...notifyFeatures,
    ...sharingFeatures,
    ...domainFeatures,
    liveHereFeature
];

// Une commande n'a qu'un handler : un module à id natif qui redéclarerait une
// commande encore native l'écraserait en silence dans la carte ci-dessous.
for (const [i, f] of featureHandlers.entries()) {
    if (featureHandlers.findIndex((g) => g.command === f.command) !== i) {
        throw new Error(`Commande « ${f.command} » déclarée deux fois (module et native ?)`);
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const featureHandlerMap: Record<string, FeatureDefinition<string, any, any>> = Object.fromEntries(
    featureHandlers.map((f) => [f.command, f])
);
