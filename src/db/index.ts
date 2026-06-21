import type { Queryable } from './pool';
import { devicesRepo, linkCodesRepo, type DevicesRepo, type LinkCodesRepo } from './repos/devices';
import { logsRepo, type LogsRepo } from './repos/logs';
import { metricsRepo, type MetricsRepo } from './repos/metrics';
import { presenceRepo, type PresenceRepo } from './repos/presence';
import { processSamplesRepo, type ProcessSamplesRepo } from './repos/processSamples';
import { noteFoldersRepo, type NoteFoldersRepo } from './repos/noteFolders';
import { notesRepo, type NotesRepo } from './repos/notes';
import { passwordsRepo, type PasswordsRepo } from './repos/passwords';
import { refreshTokensRepo, type RefreshTokensRepo } from './repos/refreshTokens';
import { twoFactorRepo, type TwoFactorRepo } from './repos/twoFactor';
import { userSecretKeysRepo, type UserSecretKeysRepo } from './repos/userSecretKeys';
import { usersRepo, type UsersRepo } from './repos/users';
import { weatherRepo, type WeatherRepo } from './repos/weather';
import {
    workspaceMembersRepo,
    workspacesRepo,
    type WorkspaceMembersRepo,
    type WorkspacesRepo
} from './repos/workspaces';

export interface Database {
    users: UsersRepo;
    workspaces: WorkspacesRepo;
    workspaceMembers: WorkspaceMembersRepo;
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
}

export function createDatabase(q: Queryable): Database {
    return {
        users: usersRepo(q),
        workspaces: workspacesRepo(q),
        workspaceMembers: workspaceMembersRepo(q),
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
        weather: weatherRepo(q)
    };
}
