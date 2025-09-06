import { Unlock } from '@/Features/Utils/unlock';
import { userManager } from '@/Services/UserManager.js';
import { ffetch } from '@/Utils/Request.js';

import type {
    DBType_Workspace,
    DBType_User,
    DBType_User_Raw,
    MinimalUserType,
    DBType_Workspace_Raw
} from 'deveye-types';
import type { IFeature } from '@/Interfaces/IFeature.js';

export const Login: IFeature<'login'> = async ({ db, profile, data }) => {
    const { token } = data;

    const requestToken = await ffetch('get-token', { code: 'UJu-79a?:w=4O7mp#sM]yQiOsI/Jb_ag', token });

    if (requestToken.status !== 0 || !requestToken.content) {
        // TODO: Alert
        return {
            status: 'error'
        };
    }

    const rawUsers = await db.users.Get({ Token: requestToken.content });
    if (rawUsers.length === 0) {
        // TODO: Alert
        return {
            status: 'error'
        };
    }

    const rawUser = rawUsers[0];

    // Update LastLogin
    await db.users.UpdateLastLogin(rawUser.ID);

    // Load workspaces
    const rawWorkspaces = await db.workspaces.GetWorkspacesWithUserAccess(rawUser.ID);
    if (rawWorkspaces.length === 0) {
        throw new Error('No workspace found for user ' + rawUser.ID);
    }

    const workspaceIds = rawWorkspaces.map((c) => c.ID);
    const otherUsers = await db.users.GetByIds(workspaceIds);
    const user = CreateUser(rawUser, rawWorkspaces, otherUsers);

    profile.user = user;
    profile.firstMessage = false;

    // TODO: Add verification
    // const userAdded =
    userManager.add(profile);
    await Unlock(db, profile, 0, data.password);

    return {
        status: 'success',
        user: user
    };
};

function CreateUser(
    rawUser: DBType_User_Raw,
    rawWorkspaces: DBType_Workspace_Raw[],
    usersInWorkspace: DBType_User_Raw[]
): DBType_User {
    const user: DBType_User = {
        ID: rawUser.ID,
        Email: rawUser.Email,
        Username: rawUser.Username,
        Avatar: rawUser.Avatar,
        Settings: JSON.parse(rawUser.Settings),
        Workspaces: [],
        DefaultWorkspace: rawUser.DefaultWorkspace,
        DefaultFeature: rawUser.DefaultFeature,
        Token: rawUser.Token,
        LastLogin: new Date(rawUser.LastLogin).getTime() / 1000,
        Created: new Date(rawUser.Created).getTime() / 1000
    };

    const selfWorkspace: DBType_Workspace = {
        id: 0,
        name: rawUser.Username,
        logo: rawUser.Avatar,
        users: [],
        features: JSON.parse(rawUser.Features),
        reAuthInterval: rawUser.ReAuthInterval,
        created: new Date(rawUser.Created).getTime() / 1000
    };

    const userWorkspaces: DBType_Workspace[] = rawWorkspaces.map((c) => ({
        id: c.ID,
        name: c.Name,
        logo: c.Logo,
        users: usersInWorkspace
            .filter((u) => u.ID === c.ID)
            .map(
                (u): MinimalUserType => ({
                    ID: u.ID,
                    Email: u.Email,
                    Username: u.Username,
                    Avatar: u.Avatar,
                    Created: new Date(u.Created).getTime() / 1000
                })
            ),
        features: JSON.parse(c.Features),
        reAuthInterval: c.ReAuthInterval,
        created: new Date(c.Created).getTime() / 1000
    }));

    user.Workspaces = [selfWorkspace, ...userWorkspaces];

    return user;
}
