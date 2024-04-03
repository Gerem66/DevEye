import { ffetch } from '../../src/Utils/Request.js';

/**
 * @typedef {import('./types.js').RequestTypes} RequestTypes
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

    const user = await db.QueryPrepare('SELECT * FROM Users WHERE Token = ?', [requestToken.content]);
    if (user === null) {
        // TODO: Alert
        return {
            status: 1,
            user: null
        };
    }

    // Update LastLogin
    db.QueryPrepare('UPDATE Users SET LastLogin = NOW() WHERE ID = ?', [ user[0].ID ]);

    user[0].LastLogin = (new Date(user[0].LastLogin)).getTime() / 1000;
    user[0].Created = (new Date(user[0].Created)).getTime() / 1000;

    // Load contexts
    /** @type {Array<{ ContextID: number }>} */
    const rawContextsID = await db.QueryPrepare('SELECT `ContextID` FROM ContextsLinks WHERE UserID = ?', [ user[0].ID ]);
    if (rawContextsID === null) {
        return {
            status: 1,
            user: null
        };
    }

    const contextsID = rawContextsID.map((c) => c.ContextID);
    /** @type {Array<{ ID: number, Name: string, Logo: string, Features: string }>} */
    const contexts = await db.ExecQuery(`SELECT * FROM Contexts WHERE ID IN (${contextsID.join(',')})`);
    if (contexts === null) {
        return {
            status: 1,
            user: null
        };
    }

    const selfContext = {
        id: 0,
        name: user[0].Username,
        logo: user[0].Avatar,
        features: JSON.parse(user[0].Features)
    };
    const userContexts = contexts.map((c) => {
        return {
            id: c.ID,
            name: c.Name,
            logo: c.Logo,
            features: JSON.parse(c.Features)
        };
    });
    user[0].Contexts = [selfContext, ...userContexts];

    return {
        status: 0,
        user: user[0]
    };
}

export { Login };
