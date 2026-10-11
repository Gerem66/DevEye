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
import { loginChecksFeatures } from './loginChecks';
import { stepUpFeatures } from './stepup';
import { twoFactorFeatures } from './twofa';
import { userDeleteAccountFeature } from './user/deleteAccount';
import { userExportPrepareFeature } from './user/exportPrepare';
import { userExportPreviewFeature } from './user/exportPreview';
import { userSetAvatarFeature } from './user/setAvatar';
import { userPlanFeature } from './user/plan';
import { userSetColorFeature } from './user/setColor';
import { userSetSettingFeature } from './user/setSetting';
import { userSetUsernameFeature } from './user/setUsername';
import { userSetThemeFeature } from './user/setTheme';
import { workspaceActivateFeature, workspaceSetFavoriteFeature } from './workspace/activate';
import {
    userInvitationsFeature,
    workspaceAcceptInviteFeature,
    workspaceCancelInviteFeature,
    workspaceDeclineInviteFeature,
    workspaceInvitationsFeature,
    workspaceInviteFeature
} from './workspace/invitations';
import {
    workspaceLeaveFeature,
    workspaceMemberSharesFeature,
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
    workspaceMemberSharesFeature,
    workspaceInviteFeature,
    workspaceInvitationsFeature,
    workspaceCancelInviteFeature,
    workspaceAcceptInviteFeature,
    workspaceDeclineInviteFeature,
    userInvitationsFeature,
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
    userExportPreviewFeature,
    userExportPrepareFeature,
    ...agentFeatures,
    ...twoFactorFeatures,
    ...stepUpFeatures,
    ...loginChecksFeatures,
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

// Une `Map` et non un objet : la commande vient du client, et `constructor` ou
// `__proto__` trouveraient sinon une entrée héritée du prototype.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const featureHandlerMap: ReadonlyMap<string, FeatureDefinition<string, any, any>> = new Map(
    featureHandlers.map((f) => [f.command, f])
);
