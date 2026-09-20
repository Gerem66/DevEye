import { getQueryable, withTransaction, type DbPool, type Queryable } from './pool';
import { devicesRepo, linkCodesRepo, type DevicesRepo, type LinkCodesRepo } from './repos/devices';
import { feedbackRepo, type FeedbackRepo } from './repos/feedback';
import { logsRepo, type LogsRepo } from './repos/logs';
import { metricsRepo, type MetricsRepo } from './repos/metrics';
import { featureDomainsRepo, type FeatureDomainsRepo } from './repos/featureDomains';
import { featureKvRepo, type FeatureKvRepo } from './repos/featureKv';
import { itemSharingRepo, type ItemSharingRepo } from './repos/itemSharing';
import { notificationChannelsRepo, type NotificationChannelsRepo } from './repos/notificationChannels';
import { pendingSignupsRepo, type PendingSignupsRepo } from './repos/pendingSignups';
import { presenceRepo, type PresenceRepo } from './repos/presence';
import { processSamplesRepo, type ProcessSamplesRepo } from './repos/processSamples';
import { refreshTokensRepo, type RefreshTokensRepo } from './repos/refreshTokens';
import { remoteInstancesRepo, type RemoteInstancesRepo } from './repos/remoteInstances';
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

export interface Database {
    /** Le Queryable brut, pour les fabriques de repos des modules uniquement. */
    queryable: Queryable;
    /**
     * Les mêmes repos sur une connexion en transaction : tout ce que `fn` écrit
     * est validé ensemble, ou rien. Réservé aux gestes qui touchent plusieurs
     * tables sans pouvoir laisser un état intermédiaire, le déplacement d'un
     * élément d'un espace à un autre étant le premier.
     */
    transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
    users: UsersRepo;
    workspaces: WorkspacesRepo;
    workspaceMembers: WorkspaceMembersRepo;
    workspaceSecretKeys: WorkspaceSecretKeysRepo;
    workspaceRoles: WorkspaceRolesRepo;
    refreshTokens: RefreshTokensRepo;
    remoteInstances: RemoteInstancesRepo;
    logs: LogsRepo;
    /** Les signalements des utilisateurs, relus par l'administration. */
    feedback: FeedbackRepo;
    devices: DevicesRepo;
    linkCodes: LinkCodesRepo;
    metrics: MetricsRepo;
    /** Les inscriptions en attente de validation par mail. */
    pendingSignups: PendingSignupsRepo;
    presence: PresenceRepo;
    processSamples: ProcessSamplesRepo;
    twoFactor: TwoFactorRepo;
    userSecretKeys: UserSecretKeysRepo;
    /** Le magasin clé-valeur des modules de features (SDK). */
    featureDomains: FeatureDomainsRepo;
    featureKv: FeatureKvRepo;
    itemSharing: ItemSharingRepo;
    /** Canaux d'alerte, par espace et par feature (voir `Services/notifications.ts`). */
    notificationChannels: NotificationChannelsRepo;
}

/**
 * Le pool plutôt qu'un `Queryable` : c'est lui, et lui seul, qui sait ouvrir une
 * transaction sur une connexion à part (cf. `Database.transaction`).
 */
export function createDatabase(pool: DbPool): Database {
    return buildDatabase(pool, getQueryable(pool), false);
}

function buildDatabase(pool: DbPool, q: Queryable, inTransaction: boolean): Database {
    return {
        queryable: q,
        // Déjà dans une transaction, on y reste : MySQL n'en imbrique pas, et
        // en ouvrir une seconde prendrait une autre connexion, qui ne verrait
        // pas les écritures en cours et attendrait leurs verrous.
        transaction: (fn) =>
            inTransaction
                ? fn(buildDatabase(pool, q, true))
                : withTransaction(pool, (txQ) => fn(buildDatabase(pool, txQ, true))),
        users: usersRepo(q),
        workspaces: workspacesRepo(q),
        workspaceMembers: workspaceMembersRepo(q),
        workspaceSecretKeys: workspaceSecretKeysRepo(q),
        workspaceRoles: workspaceRolesRepo(q),
        refreshTokens: refreshTokensRepo(q),
        remoteInstances: remoteInstancesRepo(q),
        logs: logsRepo(q),
        feedback: feedbackRepo(q),
        devices: devicesRepo(q),
        linkCodes: linkCodesRepo(q),
        metrics: metricsRepo(q),
        pendingSignups: pendingSignupsRepo(q),
        presence: presenceRepo(q),
        processSamples: processSamplesRepo(q),
        twoFactor: twoFactorRepo(q),
        userSecretKeys: userSecretKeysRepo(q),
        featureDomains: featureDomainsRepo(q),
        featureKv: featureKvRepo(q),
        itemSharing: itemSharingRepo(q),
        notificationChannels: notificationChannelsRepo(q)
    };
}
