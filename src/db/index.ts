import { getQueryable, withTransaction, type DbPool, type Queryable } from './pool';
import { debugRepo, type DebugRepo } from './repos/debug';
import { devicesRepo, linkCodesRepo, type DevicesRepo, type LinkCodesRepo } from './repos/devices';
import { feedbackRepo, type FeedbackRepo } from './repos/feedback';
import { logsRepo, type LogsRepo } from './repos/logs';
import { maintenanceRepo, type MaintenanceRepo } from './repos/maintenance';
import { metricsRepo, type MetricsRepo } from './repos/metrics';
import { featureDomainsRepo, type FeatureDomainsRepo } from './repos/featureDomains';
import { featureKvRepo, type FeatureKvRepo } from './repos/featureKv';
import { instanceSettingsRepo, type InstanceSettingsRepo } from './repos/instanceSettings';
import { itemSharingRepo, type ItemSharingRepo } from './repos/itemSharing';
import { notificationChannelsRepo, type NotificationChannelsRepo } from './repos/notificationChannels';
import { pendingSignupsRepo, type PendingSignupsRepo } from './repos/pendingSignups';
import { presenceRepo, type PresenceRepo } from './repos/presence';
import { processSamplesRepo, type ProcessSamplesRepo } from './repos/processSamples';
import { quotaPausesRepo, type QuotaPausesRepo } from './repos/quotaPauses';
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
    /** La maintenance du site et des features (voir `Services/maintenance.ts`). */
    maintenance: MaintenanceRepo;
    devices: DevicesRepo;
    linkCodes: LinkCodesRepo;
    metrics: MetricsRepo;
    /** Les inscriptions en attente de validation par mail. */
    pendingSignups: PendingSignupsRepo;
    presence: PresenceRepo;
    processSamples: ProcessSamplesRepo;
    /** Ce que l'offre de son propriétaire tient en pause (voir `Services/planPauses.ts`). */
    quotaPauses: QuotaPausesRepo;
    twoFactor: TwoFactorRepo;
    userSecretKeys: UserSecretKeysRepo;
    /** Le magasin clé-valeur des modules de features (SDK). */
    featureDomains: FeatureDomainsRepo;
    featureKv: FeatureKvRepo;
    itemSharing: ItemSharingRepo;
    /** Canaux d'alerte, par espace et par feature (voir `Services/notifications.ts`). */
    notificationChannels: NotificationChannelsRepo;
    /** Les réglages de l'instance, par origine publique. */
    instanceSettings: InstanceSettingsRepo;
    /** Les essais de la page Tests et débogage (voir `Services/debug/`). */
    debug: DebugRepo;
}

/** Ouvre une transaction et y prête sa connexion le temps de `fn`. */
export type BeginTransaction = <T>(fn: (q: Queryable) => Promise<T>) => Promise<T>;

/**
 * Le pool plutôt qu'un `Queryable` : c'est lui, et lui seul, qui sait ouvrir une
 * transaction sur une connexion à part (cf. `Database.transaction`).
 */
export function createDatabase(pool: DbPool): Database {
    return databaseOn(getQueryable(pool), (fn) => withTransaction(pool, fn));
}

/** Les dépôts sur ce `Queryable`, `begin` ouvrant leurs transactions. */
export function databaseOn(q: Queryable, begin: BeginTransaction): Database {
    return {
        queryable: q,
        // Déjà dans une transaction, on y reste : MySQL n'en imbrique pas, et
        // en ouvrir une seconde prendrait une autre connexion, qui ne verrait
        // pas les écritures en cours et attendrait leurs verrous.
        transaction: (fn) => begin((txQ) => fn(databaseOn(txQ, (inner) => inner(txQ)))),
        users: usersRepo(q),
        workspaces: workspacesRepo(q),
        workspaceMembers: workspaceMembersRepo(q),
        workspaceSecretKeys: workspaceSecretKeysRepo(q),
        workspaceRoles: workspaceRolesRepo(q),
        refreshTokens: refreshTokensRepo(q),
        remoteInstances: remoteInstancesRepo(q),
        logs: logsRepo(q),
        feedback: feedbackRepo(q),
        maintenance: maintenanceRepo(q),
        devices: devicesRepo(q),
        linkCodes: linkCodesRepo(q),
        metrics: metricsRepo(q),
        pendingSignups: pendingSignupsRepo(q),
        presence: presenceRepo(q),
        processSamples: processSamplesRepo(q),
        quotaPauses: quotaPausesRepo(q),
        twoFactor: twoFactorRepo(q),
        userSecretKeys: userSecretKeysRepo(q),
        featureDomains: featureDomainsRepo(q),
        featureKv: featureKvRepo(q),
        itemSharing: itemSharingRepo(q),
        notificationChannels: notificationChannelsRepo(q),
        instanceSettings: instanceSettingsRepo(q),
        debug: debugRepo(q)
    };
}
