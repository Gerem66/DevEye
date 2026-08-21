import type { Queryable } from './pool';
import { devicesRepo, linkCodesRepo, type DevicesRepo, type LinkCodesRepo } from './repos/devices';
import { logsRepo, type LogsRepo } from './repos/logs';
import {
    mailAccountsRepo,
    mailFoldersRepo,
    mailMessagesRepo,
    mailSettingsRepo,
    type MailAccountsRepo,
    type MailFoldersRepo,
    type MailMessagesRepo,
    type MailSettingsRepo
} from './repos/mail';
import { metricsRepo, type MetricsRepo } from './repos/metrics';
import { featureKvRepo, type FeatureKvRepo } from './repos/featureKv';
import { itemSharingRepo, type ItemSharingRepo } from './repos/itemSharing';
import { notificationChannelsRepo, type NotificationChannelsRepo } from './repos/notificationChannels';
import { presenceRepo, type PresenceRepo } from './repos/presence';
import { processSamplesRepo, type ProcessSamplesRepo } from './repos/processSamples';
import {
    allowRepo,
    baselineRepo,
    findingsRepo,
    type AllowRepo,
    type BaselineRepo,
    type FindingsRepo
} from './repos/sentinel';
import { noteFoldersRepo, type NoteFoldersRepo } from './repos/noteFolders';
import { notesRepo, type NotesRepo } from './repos/notes';
import { osintRepo, type OsintRepo } from './repos/osint';
import { projectsRepo, type ProjectsRepo } from './repos/projects';
import { projectRekeyRepo, type ProjectRekeyRepo } from './repos/projectRekey';
import { projectBoardRepo, type ProjectBoardRepo } from './repos/projectBoard';
import { projectChatRepo, type ProjectChatRepo } from './repos/projectChat';
import { projectPlanRepo, type ProjectPlanRepo } from './repos/projectPlan';
import { projectHistoryRepo, type ProjectHistoryRepo } from './repos/projectHistory';
import { databaseRepo, type DatabaseRepo } from './repos/database';
import { financeRepo, type FinanceRepo } from './repos/finance';
import { audienceRepo, type AudienceRepo } from './repos/audience';
import { audienceIngestRepo, type AudienceIngestRepo } from './repos/audienceIngest';
import { audienceFunnelsRepo, type AudienceFunnelsRepo } from './repos/audienceFunnels';
import { gitRepo, type GitRepo } from './repos/git';
import { credentialsRepo, type CredentialsRepo } from './repos/credentials';
import { deployRepo, type DeployRepo } from './repos/deploy';
import { backupRepo, type BackupRepo } from './repos/backup';
import { projectLinksRepo, type ProjectLinksRepo } from './repos/projectLinks';
import { passwordsRepo, type PasswordsRepo } from './repos/passwords';
import { refreshTokensRepo, type RefreshTokensRepo } from './repos/refreshTokens';
import { syncEventsRepo, type SyncEventsRepo } from './repos/syncEvents';
import { syncFilesRepo, type SyncFilesRepo } from './repos/syncFiles';
import { syncMetaRepo, type SyncMetaRepo } from './repos/syncMeta';
import { syncSessionsRepo, type SyncSessionsRepo } from './repos/syncSessions';
import { syncSharesRepo, type SyncSharesRepo } from './repos/syncShares';
import { syncSnapshotsRepo, type SyncSnapshotsRepo } from './repos/syncSnapshots';
import { syncVersionsRepo, type SyncVersionsRepo } from './repos/syncVersions';
import { twoFactorRepo, type TwoFactorRepo } from './repos/twoFactor';
import { uptimeHistoryRepo, uptimeServicesRepo, type UptimeHistoryRepo, type UptimeServicesRepo } from './repos/uptime';
import { userSecretKeysRepo, type UserSecretKeysRepo } from './repos/userSecretKeys';
import { usersRepo, type UsersRepo } from './repos/users';
import {
    workspaceMembersRepo,
    workspacesRepo,
    type WorkspaceMembersRepo,
    type WorkspacesRepo
} from './repos/workspaces';
import { workspaceSecretKeysRepo, type WorkspaceSecretKeysRepo } from './repos/workspaceSecretKeys';
import { workspaceRekeyRepo, type WorkspaceRekeyRepo } from './repos/workspaceRekey';
import { workspaceRolesRepo, type WorkspaceRolesRepo } from './repos/workspaceRoles';
import { userInvitesRepo, type UserInvitesRepo } from './repos/userInvites';

export interface Database {
    /**
     * Le Queryable brut, pour les fabriques de repos des MODULES uniquement :
     * un repo de module se construit avec, un handler natif n'a aucune raison
     * d'y toucher (ses repos sont déjà là).
     */
    queryable: Queryable;
    users: UsersRepo;
    workspaces: WorkspacesRepo;
    workspaceMembers: WorkspaceMembersRepo;
    workspaceSecretKeys: WorkspaceSecretKeysRepo;
    workspaceRekey: WorkspaceRekeyRepo;
    workspaceRoles: WorkspaceRolesRepo;
    userInvites: UserInvitesRepo;
    refreshTokens: RefreshTokensRepo;
    logs: LogsRepo;
    passwords: PasswordsRepo;
    notes: NotesRepo;
    projects: ProjectsRepo;
    projectRekey: ProjectRekeyRepo;
    projectBoard: ProjectBoardRepo;
    projectChat: ProjectChatRepo;
    projectPlan: ProjectPlanRepo;
    projectHistory: ProjectHistoryRepo;
    git: GitRepo;
    /** Les jetons d'accès de l'espace, partagés par Git et Déploiement. */
    credentials: CredentialsRepo;
    deploy: DeployRepo;
    /**
     * Sauvegardes : destinations, travaux et exécutions. Un seul dépôt pour les
     * trois tables — elles ne se lisent jamais séparément, et la rétention les
     * traverse toutes les trois.
     */
    backup: BackupRepo;
    databases: DatabaseRepo;
    /**
     * Le grand livre de l'espace: comptes, opérations, budgets, échéances.
     * Un seul dépôt pour les cinq tables, parce qu'elles ne se lisent jamais
     * séparément (un solde est une agrégation des opérations sur les comptes).
     */
    finance: FinanceRepo;
    /** Les sites suivis de l'espace, et leurs statistiques — le chemin froid. */
    audience: AudienceRepo;
    /**
     * Le chemin **chaud** de l'audience : ce que l'ingestion publique écrit.
     * Séparé exprès, il ne bat pas au même rythme que le reste (voir
     * `repos/audienceIngest.ts`).
     */
    audienceIngest: AudienceIngestRepo;
    /** Les entonnoirs : des lectures des événements, jamais une collecte à part. */
    audienceFunnels: AudienceFunnelsRepo;
    projectLinks: ProjectLinksRepo;
    noteFolders: NoteFoldersRepo;
    devices: DevicesRepo;
    linkCodes: LinkCodesRepo;
    metrics: MetricsRepo;
    presence: PresenceRepo;
    processSamples: ProcessSamplesRepo;
    /** Sentinelle : ce qui a été observé, ce qui en a été jugé, ce qu'un humain a décidé. */
    baseline: BaselineRepo;
    findings: FindingsRepo;
    sentinelAllow: AllowRepo;
    twoFactor: TwoFactorRepo;
    userSecretKeys: UserSecretKeysRepo;
    /** Le magasin clé-valeur des modules de features (SDK). */
    featureKv: FeatureKvRepo;
    osint: OsintRepo;
    uptimeServices: UptimeServicesRepo;
    uptimeHistory: UptimeHistoryRepo;
    /** Canaux d'alerte, par espace **et par feature** (voir `Services/notifications.ts`). */
    itemSharing: ItemSharingRepo;
    notificationChannels: NotificationChannelsRepo;
    mailAccounts: MailAccountsRepo;
    mailFolders: MailFoldersRepo;
    mailMessages: MailMessagesRepo;
    mailSettings: MailSettingsRepo;
    syncMeta: SyncMetaRepo;
    syncShares: SyncSharesRepo;
    syncFiles: SyncFilesRepo;
    syncVersions: SyncVersionsRepo;
    syncSnapshots: SyncSnapshotsRepo;
    syncSessions: SyncSessionsRepo;
    syncEvents: SyncEventsRepo;
}

export function createDatabase(q: Queryable): Database {
    return {
        queryable: q,
        users: usersRepo(q),
        workspaces: workspacesRepo(q),
        workspaceMembers: workspaceMembersRepo(q),
        workspaceSecretKeys: workspaceSecretKeysRepo(q),
        workspaceRekey: workspaceRekeyRepo(q),
        workspaceRoles: workspaceRolesRepo(q),
        userInvites: userInvitesRepo(q),
        refreshTokens: refreshTokensRepo(q),
        logs: logsRepo(q),
        passwords: passwordsRepo(q),
        notes: notesRepo(q),
        projects: projectsRepo(q),
        projectRekey: projectRekeyRepo(q),
        projectBoard: projectBoardRepo(q),
        projectChat: projectChatRepo(q),
        projectPlan: projectPlanRepo(q),
        projectHistory: projectHistoryRepo(q),
        git: gitRepo(q),
        credentials: credentialsRepo(q),
        deploy: deployRepo(q),
        backup: backupRepo(q),
        databases: databaseRepo(q),
        finance: financeRepo(q),
        audience: audienceRepo(q),
        audienceIngest: audienceIngestRepo(q),
        audienceFunnels: audienceFunnelsRepo(q),
        projectLinks: projectLinksRepo(q),
        noteFolders: noteFoldersRepo(q),
        devices: devicesRepo(q),
        linkCodes: linkCodesRepo(q),
        metrics: metricsRepo(q),
        presence: presenceRepo(q),
        processSamples: processSamplesRepo(q),
        baseline: baselineRepo(q),
        findings: findingsRepo(q),
        sentinelAllow: allowRepo(q),
        twoFactor: twoFactorRepo(q),
        userSecretKeys: userSecretKeysRepo(q),
        featureKv: featureKvRepo(q),
        osint: osintRepo(q),
        uptimeServices: uptimeServicesRepo(q),
        uptimeHistory: uptimeHistoryRepo(q),
        itemSharing: itemSharingRepo(q),
        notificationChannels: notificationChannelsRepo(q),
        mailAccounts: mailAccountsRepo(q),
        mailFolders: mailFoldersRepo(q),
        mailMessages: mailMessagesRepo(q),
        mailSettings: mailSettingsRepo(q),
        syncMeta: syncMetaRepo(q),
        syncShares: syncSharesRepo(q),
        syncFiles: syncFilesRepo(q),
        syncVersions: syncVersionsRepo(q),
        syncSnapshots: syncSnapshotsRepo(q),
        syncSessions: syncSessionsRepo(q),
        syncEvents: syncEventsRepo(q)
    };
}
