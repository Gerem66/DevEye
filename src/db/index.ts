import type { Queryable } from './pool';
import { devicesRepo, linkCodesRepo, type DevicesRepo, type LinkCodesRepo } from './repos/devices';
import { logsRepo, type LogsRepo } from './repos/logs';
import { metricsRepo, type MetricsRepo } from './repos/metrics';
import { featureKvRepo, type FeatureKvRepo } from './repos/featureKv';
import { itemSharingRepo, type ItemSharingRepo } from './repos/itemSharing';
import { notificationChannelsRepo, type NotificationChannelsRepo } from './repos/notificationChannels';
import { presenceRepo, type PresenceRepo } from './repos/presence';
import { processSamplesRepo, type ProcessSamplesRepo } from './repos/processSamples';
import { refreshTokensRepo, type RefreshTokensRepo } from './repos/refreshTokens';
import { twoFactorRepo, type TwoFactorRepo } from './repos/twoFactor';
import { userSecretKeysRepo, type UserSecretKeysRepo } from './repos/userSecretKeys';
import { usersRepo, type UsersRepo } from './repos/users';
import {
    workspaceMembersRepo,
    workspacesRepo,
    type WorkspaceMembersRepo,
    type WorkspacesRepo
} from './repos/workspaces';
import { workspaceSecretKeysRepo, type WorkspaceSecretKeysRepo } from './repos/workspaceSecretKeys';
import { workspaceRolesRepo, type WorkspaceRolesRepo } from './repos/workspaceRoles';
import { userInvitesRepo, type UserInvitesRepo } from './repos/userInvites';

export interface Database {
    /** Le Queryable brut, pour les fabriques de repos des modules uniquement. */
    queryable: Queryable;
    users: UsersRepo;
    workspaces: WorkspacesRepo;
    workspaceMembers: WorkspaceMembersRepo;
    workspaceSecretKeys: WorkspaceSecretKeysRepo;
    workspaceRoles: WorkspaceRolesRepo;
    userInvites: UserInvitesRepo;
    refreshTokens: RefreshTokensRepo;
    logs: LogsRepo;
    devices: DevicesRepo;
    linkCodes: LinkCodesRepo;
    metrics: MetricsRepo;
    presence: PresenceRepo;
    processSamples: ProcessSamplesRepo;
    twoFactor: TwoFactorRepo;
    userSecretKeys: UserSecretKeysRepo;
    /** Le magasin clé-valeur des modules de features (SDK). */
    featureKv: FeatureKvRepo;
    itemSharing: ItemSharingRepo;
    /** Canaux d'alerte, par espace et par feature (voir `Services/notifications.ts`). */
    notificationChannels: NotificationChannelsRepo;
}

export function createDatabase(q: Queryable): Database {
    return {
        queryable: q,
        users: usersRepo(q),
        workspaces: workspacesRepo(q),
        workspaceMembers: workspaceMembersRepo(q),
        workspaceSecretKeys: workspaceSecretKeysRepo(q),
        workspaceRoles: workspaceRolesRepo(q),
        userInvites: userInvitesRepo(q),
        refreshTokens: refreshTokensRepo(q),
        logs: logsRepo(q),
        devices: devicesRepo(q),
        linkCodes: linkCodesRepo(q),
        metrics: metricsRepo(q),
        presence: presenceRepo(q),
        processSamples: processSamplesRepo(q),
        twoFactor: twoFactorRepo(q),
        userSecretKeys: userSecretKeysRepo(q),
        featureKv: featureKvRepo(q),
        itemSharing: itemSharingRepo(q),
        notificationChannels: notificationChannelsRepo(q)
    };
}
