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
import { presenceRepo, type PresenceRepo } from './repos/presence';
import { processSamplesRepo, type ProcessSamplesRepo } from './repos/processSamples';
import { noteFoldersRepo, type NoteFoldersRepo } from './repos/noteFolders';
import { notesRepo, type NotesRepo } from './repos/notes';
import { passwordsRepo, type PasswordsRepo } from './repos/passwords';
import { refreshTokensRepo, type RefreshTokensRepo } from './repos/refreshTokens';
import { syncEventsRepo, type SyncEventsRepo } from './repos/syncEvents';
import { syncFilesRepo, type SyncFilesRepo } from './repos/syncFiles';
import { syncMetaRepo, type SyncMetaRepo } from './repos/syncMeta';
import { syncSessionsRepo, type SyncSessionsRepo } from './repos/syncSessions';
import { syncSharesRepo, type SyncSharesRepo } from './repos/syncShares';
import { syncVersionsRepo, type SyncVersionsRepo } from './repos/syncVersions';
import { twoFactorRepo, type TwoFactorRepo } from './repos/twoFactor';
import {
    uptimeHistoryRepo,
    uptimeServicesRepo,
    uptimeSettingsRepo,
    type UptimeHistoryRepo,
    type UptimeServicesRepo,
    type UptimeSettingsRepo
} from './repos/uptime';
import { userSecretKeysRepo, type UserSecretKeysRepo } from './repos/userSecretKeys';
import { usersRepo, type UsersRepo } from './repos/users';
import { weatherRepo, type WeatherRepo } from './repos/weather';
import {
    workspaceMembersRepo,
    workspacesRepo,
    type WorkspaceMembersRepo,
    type WorkspacesRepo
} from './repos/workspaces';
import { workspaceInvitesRepo, type WorkspaceInvitesRepo } from './repos/workspaceInvites';
import { workspaceSecretKeysRepo, type WorkspaceSecretKeysRepo } from './repos/workspaceSecretKeys';
import { workspaceRekeyRepo, type WorkspaceRekeyRepo } from './repos/workspaceRekey';

export interface Database {
    users: UsersRepo;
    workspaces: WorkspacesRepo;
    workspaceMembers: WorkspaceMembersRepo;
    workspaceInvites: WorkspaceInvitesRepo;
    workspaceSecretKeys: WorkspaceSecretKeysRepo;
    workspaceRekey: WorkspaceRekeyRepo;
    refreshTokens: RefreshTokensRepo;
    logs: LogsRepo;
    passwords: PasswordsRepo;
    notes: NotesRepo;
    noteFolders: NoteFoldersRepo;
    devices: DevicesRepo;
    linkCodes: LinkCodesRepo;
    metrics: MetricsRepo;
    presence: PresenceRepo;
    processSamples: ProcessSamplesRepo;
    twoFactor: TwoFactorRepo;
    userSecretKeys: UserSecretKeysRepo;
    weather: WeatherRepo;
    uptimeServices: UptimeServicesRepo;
    uptimeHistory: UptimeHistoryRepo;
    uptimeSettings: UptimeSettingsRepo;
    mailAccounts: MailAccountsRepo;
    mailFolders: MailFoldersRepo;
    mailMessages: MailMessagesRepo;
    mailSettings: MailSettingsRepo;
    syncMeta: SyncMetaRepo;
    syncShares: SyncSharesRepo;
    syncFiles: SyncFilesRepo;
    syncVersions: SyncVersionsRepo;
    syncSessions: SyncSessionsRepo;
    syncEvents: SyncEventsRepo;
}

export function createDatabase(q: Queryable): Database {
    return {
        users: usersRepo(q),
        workspaces: workspacesRepo(q),
        workspaceMembers: workspaceMembersRepo(q),
        workspaceInvites: workspaceInvitesRepo(q),
        workspaceSecretKeys: workspaceSecretKeysRepo(q),
        workspaceRekey: workspaceRekeyRepo(q),
        refreshTokens: refreshTokensRepo(q),
        logs: logsRepo(q),
        passwords: passwordsRepo(q),
        notes: notesRepo(q),
        noteFolders: noteFoldersRepo(q),
        devices: devicesRepo(q),
        linkCodes: linkCodesRepo(q),
        metrics: metricsRepo(q),
        presence: presenceRepo(q),
        processSamples: processSamplesRepo(q),
        twoFactor: twoFactorRepo(q),
        userSecretKeys: userSecretKeysRepo(q),
        weather: weatherRepo(q),
        uptimeServices: uptimeServicesRepo(q),
        uptimeHistory: uptimeHistoryRepo(q),
        uptimeSettings: uptimeSettingsRepo(q),
        mailAccounts: mailAccountsRepo(q),
        mailFolders: mailFoldersRepo(q),
        mailMessages: mailMessagesRepo(q),
        mailSettings: mailSettingsRepo(q),
        syncMeta: syncMetaRepo(q),
        syncShares: syncSharesRepo(q),
        syncFiles: syncFilesRepo(q),
        syncVersions: syncVersionsRepo(q),
        syncSessions: syncSessionsRepo(q),
        syncEvents: syncEventsRepo(q)
    };
}
