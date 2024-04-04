import { ffetch } from '../../src/Utils/Request.js';

/**
 * @typedef {import('./types.js').RequestTypes} RequestTypes
 * @typedef {import('Types/User.js').UserType} UserType
 * @typedef {import('Types/User.js').DBUserType} DBUserType
 * @typedef {import('Types/User.js').TCPUserType} TCPUserType
 * @typedef {import('Types/Context.js').ContextType} ContextType
 * @typedef {import('Types/Context.js').DBContextType} DBContextType
 */

/**
 * @template {RequestTypes} T
 * @typedef {import('./types.js').TCPFeatureType<T>} TCPFeatureType
 */

/** @type {TCPFeatureType<'login'>} */
async function Login({ db, data }) {
    const { token } = data;

    // Check token & code
    const code = 'UJu-79a?:w=4O7mp#sM]yQiOsI/Jb_ag';
    const requestToken = await ffetch('get-token', { code, token });

    if (requestToken.status !== 0) {
        // TODO: Alert
        return {
            status: 1,
            user: null
        };
    }

    /** @type {Array<DBUserType>} */
    const rawUser = await db.QueryPrepare('SELECT * FROM Users WHERE Token = ?', [requestToken.content]);
    if (rawUser === null || rawUser.length === 0) {
        // TODO: Alert
        return {
            status: 1,
            user: null
        };
    }

    // Update LastLogin
    db.QueryPrepare('UPDATE Users SET LastLogin = NOW() WHERE ID = ?', [ rawUser[0].ID ]);

    /** @type {UserType} */
    const user = {
        ID: rawUser[0].ID,
        Email: rawUser[0].Email,
        Username: rawUser[0].Username,
        Password: rawUser[0].Password,
        Avatar: rawUser[0].Avatar,
        Settings: JSON.parse(rawUser[0].Settings),
        Contexts: [],
        DefaultContext: rawUser[0].DefaultContext,
        DefaultFeature: rawUser[0].DefaultFeature,
        Token: rawUser[0].Token,
        LastLogin: (new Date(rawUser[0].LastLogin)).getTime() / 1000,
        Created: (new Date(rawUser[0].Created)).getTime() / 1000
    };

    // Load contexts
    /** @type {Array<DBContextType>} */
    const rawContexts = await db.QueryPrepare(
        `SELECT Contexts.*
            FROM Contexts
            JOIN ContextsLinks ON Contexts.ID = ContextsLinks.ContextID
            WHERE ContextsLinks.UserID = ?`,
        [ user.ID ]
    );
    if (rawContexts === null) {
        return {
            status: 1,
            user: null
        };
    }

    const tcpUsers = rawContexts.map((c) => c.ID);

    /** @type {Array<DBUserType>} */
    const rawUsers = await db.ExecQuery(
        `SELECT * FROM Users WHERE ID IN (${tcpUsers.join(',')})`
    );
    if (rawUsers === null) {
        return {
            status: 1,
            user: null
        };
    }

    /** @type {ContextType} */
    const selfContext = {
        id: 0,
        name: user.Username,
        logo: user.Avatar,
        users: [],
        features: JSON.parse(rawUser[0].Features),
        created: user.Created
    };

    /** @type {Array<ContextType>} */
    const userContexts = rawContexts.map((c) => {
        return {
            id: c.ID,
            name: c.Name,
            logo: c.Logo,
            users: [
                ...rawUsers.filter((u) => u.ID === c.ID).map((u) => /** @type {TCPUserType} */ ({
                        ID: u.ID,
                        Email: u.Email,
                        Username: u.Username,
                        Avatar: u.Avatar,
                        Created: (new Date(u.Created)).getTime() / 1000
                    })
                )
            ],
            features: JSON.parse(c.Features),
            created: new Date(c.Created).getTime() / 1000
        };
    });

    user.Contexts = [selfContext, ...userContexts];

    return {
        status: 0,
        user: user
    };
}

/** @type {TCPFeatureType<'change-favorite-context'>} */
async function SetFavorite({ db, profile, data }) {
    const { contextID, featureID } = data;
    const { user } = profile;

    if (user === null) {
        return {
            status: 1
        };
    }

    const result = await db.QueryPrepare(
        'UPDATE Users SET DefaultContext = ?, DefaultFeature = ? WHERE ID = ?',
        [ contextID, featureID, user.ID ]
    );
    if (result === null || result.affectedRows === 0) {
        return {
            status: 2
        };
    }

    return {
        status: 0
    };
}

export { Login, SetFavorite };
