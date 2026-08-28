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
import { projectsRepo, type ProjectsRepo } from './repos/projects';
import { projectRekeyRepo, type ProjectRekeyRepo } from './repos/projectRekey';
import { projectBoardRepo, type ProjectBoardRepo } from './repos/projectBoard';
import { projectChatRepo, type ProjectChatRepo } from './repos/projectChat';
import { projectPlanRepo, type ProjectPlanRepo } from './repos/projectPlan';
import { projectHistoryRepo, type ProjectHistoryRepo } from './repos/projectHistory';
import { audienceRepo, type AudienceRepo } from './repos/audience';
import { audienceIngestRepo, type AudienceIngestRepo } from './repos/audienceIngest';
import { audienceFunnelsRepo, type AudienceFunnelsRepo } from './repos/audienceFunnels';
import { gitRepo, type GitRepo } from './repos/git';
import { credentialsRepo, type CredentialsRepo } from './repos/credentials';
import { deployRepo, type DeployRepo } from './repos/deploy';
import { projectLinksRepo, type ProjectLinksRepo } from './repos/projectLinks';
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
    workspaceRoles: WorkspaceRolesRepo;
    userInvites: UserInvitesRepo;
    refreshTokens: RefreshTokensRepo;
    logs: LogsRepo;
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
    /** Les liaisons d'un projet vers les services surveillés et les bases de données. */
    projectLinks: ProjectLinksRepo;
    devices: DevicesRepo;
    linkCodes: LinkCodesRepo;
    metrics: MetricsRepo;
    presence: PresenceRepo;
    processSamples: ProcessSamplesRepo;
    twoFactor: TwoFactorRepo;
    userSecretKeys: UserSecretKeysRepo;
    /** Le magasin clé-valeur des modules de features (SDK). */
    featureKv: FeatureKvRepo;
    /** Canaux d'alerte, par espace **et par feature** (voir `Services/notifications.ts`). */
    itemSharing: ItemSharingRepo;
    notificationChannels: NotificationChannelsRepo;
    mailAccounts: MailAccountsRepo;
    mailFolders: MailFoldersRepo;
    mailMessages: MailMessagesRepo;
    mailSettings: MailSettingsRepo;
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
        projects: projectsRepo(q),
        projectRekey: projectRekeyRepo(q),
        projectBoard: projectBoardRepo(q),
        projectChat: projectChatRepo(q),
        projectPlan: projectPlanRepo(q),
        projectHistory: projectHistoryRepo(q),
        git: gitRepo(q),
        credentials: credentialsRepo(q),
        deploy: deployRepo(q),
        audience: audienceRepo(q),
        audienceIngest: audienceIngestRepo(q),
        audienceFunnels: audienceFunnelsRepo(q),
        projectLinks: projectLinksRepo(q),
        devices: devicesRepo(q),
        linkCodes: linkCodesRepo(q),
        metrics: metricsRepo(q),
        presence: presenceRepo(q),
        processSamples: processSamplesRepo(q),
        twoFactor: twoFactorRepo(q),
        userSecretKeys: userSecretKeysRepo(q),
        featureKv: featureKvRepo(q),
        itemSharing: itemSharingRepo(q),
        notificationChannels: notificationChannelsRepo(q),
        mailAccounts: mailAccountsRepo(q),
        mailFolders: mailFoldersRepo(q),
        mailMessages: mailMessagesRepo(q),
        mailSettings: mailSettingsRepo(q)
    };
}
