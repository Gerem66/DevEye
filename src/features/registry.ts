import type { FeatureDefinition } from './_define';
import { deviceFeatures } from './devices';
import { homeFeatures } from './home';
import { adminFeatures } from './admin';
import { liveHereFeature } from './live/here';
import { logsFeatures } from './logs';
import { mailFeatures } from './mail';
import { notifyFeatures } from './notify';
import { sharingFeatures } from './sharing';
import { metricsFeatures } from './metrics';
import { noteFeatures } from './note';
import { databaseFeatures } from './database';
import { audienceFeatures } from './audience';
import { gitFeatures } from './git';
import { deployFeatures } from './deploy';
import { backupFeatures } from './backup';
import { financeFeatures } from './finance';
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
import { sentinelFeatures } from './sentinel';
import { uptimeFeatures } from './uptime';
import { userSetAvatarFeature } from './user/setAvatar';
import { userSetColorFeature } from './user/setColor';
import { userSetSettingFeature } from './user/setSetting';
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
import { workspaceAddFeature } from './workspace/add';
import { workspaceDeleteFeature } from './workspace/delete';
import { INSTALLED_MODULES } from './_generated/installed';
import { moduleFeatureHandlers, registerModules } from './_sdk/register';

// Les modules installés s'enregistrent au chargement du registre : manifests
// validés, descripteurs déclarés, définitions projetées en natives. Une
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
    userSetAvatarFeature,
    userSetThemeFeature,
    userSetColorFeature,
    userSetSettingFeature,
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
    ...deployFeatures,
    ...backupFeatures,
    ...databaseFeatures,
    ...financeFeatures,
    ...audienceFeatures,
    ...deviceFeatures,
    ...metricsFeatures,
    ...twoFactorFeatures,
    ...secrecyFeatures,
    ...sentinelFeatures,
    ...uptimeFeatures,
    ...logsFeatures,
    ...adminFeatures,
    ...homeFeatures,
    ...mailFeatures,
    ...notifyFeatures,
    ...sharingFeatures,
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
