import { ResultSetHeader } from 'mysql2';

import type { UserType } from 'deveye-types';
import type { DBUserType } from 'deveye-types';
import type { TCPUserType } from 'deveye-types';
import type { ContextType } from 'deveye-types';
import type { DBContextType } from 'deveye-types';

import { Unlock } from './unlock.js';
import { ffetch } from '@/Utils/Request.js';
import type { TCPFeatureType } from './types.js';
import { userManager } from '@/Services/UserManager.js';

export const Login: TCPFeatureType<'login'> = async ({ db, profile, data }) => {
    const { token } = data;

    const requestToken = await ffetch('get-token', { code: 'UJu-79a?:w=4O7mp#sM]yQiOsI/Jb_ag', token });

    if (requestToken.status !== 0 || !requestToken.content) {
        // TODO: Alert
        return {
            status: 1,
            user: null
        };
    }

    const rawUser = await db.QueryPrepare<DBUserType[]>('SELECT * FROM Users WHERE Token = ?', [requestToken.content]);
    if (rawUser === null || rawUser.length === 0) {
        // TODO: Alert
        return {
            status: 1,
            user: null
        };
    }

    // Update LastLogin
    db.QueryPrepare<ResultSetHeader>('UPDATE Users SET LastLogin = NOW() WHERE ID = ?', [rawUser[0].ID]);

    const user: UserType = {
        ID: rawUser[0].ID,
        Email: rawUser[0].Email,
        Username: rawUser[0].Username,
        Avatar: rawUser[0].Avatar,
        Settings: JSON.parse(rawUser[0].Settings),
        Contexts: [],
        DefaultContext: rawUser[0].DefaultContext,
        DefaultFeature: rawUser[0].DefaultFeature,
        Token: rawUser[0].Token,
        LastLogin: new Date(rawUser[0].LastLogin).getTime() / 1000,
        Created: new Date(rawUser[0].Created).getTime() / 1000
    };

    // Load contexts
    const rawContexts = await db.QueryPrepare<DBContextType[]>(
        `SELECT Contexts.*
            FROM Contexts
            JOIN ContextsLinks ON Contexts.ID = ContextsLinks.ContextID
            WHERE ContextsLinks.UserID = ?`,
        [user.ID]
    );
    if (rawContexts === null) {
        return {
            status: 1,
            user: null
        };
    }

    const tcpUsers = rawContexts.map((c) => c.ID);

    let rawUsers: DBUserType[] = [];

    if (tcpUsers.length > 0) {
        try {
            rawUsers = await db.ExecQuery<DBUserType[] | null>(
                `SELECT * FROM Users WHERE ID IN (${tcpUsers.join(',')})`
            );
        } catch {
            return {
                status: 1,
                user: null
            };
        }
    }

    const selfContext: ContextType = {
        id: 0,
        name: user.Username,
        logo: user.Avatar,
        users: [],
        features: JSON.parse(rawUser[0].Features),
        reAuthInterval: rawUser[0].ReAuthInterval,
        created: user.Created
    };

    const userContexts: ContextType[] = rawContexts.map((c) => {
        return {
            id: c.ID,
            name: c.Name,
            logo: c.Logo,
            users: [
                ...rawUsers
                    .filter((u) => u.ID === c.ID)
                    .map(
                        (u): TCPUserType => ({
                            ID: u.ID,
                            Email: u.Email,
                            Username: u.Username,
                            Avatar: u.Avatar,
                            Created: new Date(u.Created).getTime() / 1000
                        })
                    )
            ],
            features: JSON.parse(c.Features),
            reAuthInterval: c.ReAuthInterval,
            created: new Date(c.Created).getTime() / 1000
        };
    });

    user.Contexts = [selfContext, ...userContexts];

    profile.user = user;
    profile.firstMessage = false;

    userManager.add(profile);
    await Unlock(db, profile, 0, data.password);

    return {
        status: 0,
        user: user
    };
};
