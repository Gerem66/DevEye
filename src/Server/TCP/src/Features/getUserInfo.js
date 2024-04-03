import { ffetch } from '../../src/Utils/Request.js';

/**
 * @typedef {import('../../src/SQL.js').default} SQL
 * @typedef {import('Types/TCP.js').SendRequestType} SendRequestType
 * @typedef {import('Types/TCP.js').ReceiveRequestType} ReceiveRequestType
 */

/**
 * @template {keyof SendRequestType} T
 * @typedef {import('Types/TCP.js').TCPRequestSendHeader<T>} TCPRequestSendHeader
 */

/**
 * @template {keyof ReceiveRequestType} T
 * @typedef {import('Types/TCP.js').TCPRequestReceiveHeader<T>} TCPRequestReceiveHeader
 */

/**
 * @param {SQL} database
 * @param {TCPRequestSendHeader<'login'>} data
 * @returns {Promise<TCPRequestReceiveHeader<'login'>>}
 */
async function Login(database, data) {
    // Check token & code
    const code = 'UJu-79a?:w=4O7mp#sM]yQiOsI/Jb_ag';
    const token = data.content.token;
    const requestToken = await ffetch('get-token', { code, token });
    if (requestToken.status !== 0) {
        // TODO: Alert
        return {
            action: 'login',
            content: {
                status: 1,
                user: null
            },
            callbackID: ''
        };
    }

    const user = await database.QueryPrepare('SELECT * FROM Users WHERE Token = ?', [requestToken.content]);
    if (user === null) {
        // TODO: Alert
        return {
            action: 'login',
            content: {
                status: 1,
                user: null
            },
            callbackID: data.callbackID
        };
    }

    // Update LastLogin
    database.QueryPrepare('UPDATE Users SET LastLogin = NOW() WHERE ID = ?', [ user[0].ID ]);

    user[0].LastLogin = (new Date(user[0].LastLogin)).getTime() / 1000;
    user[0].Created = (new Date(user[0].Created)).getTime() / 1000;

    // Load contexts
    /** @type {Array<{ ContextID: number }>} */
    const rawContextsID = await database.QueryPrepare('SELECT `ContextID` FROM ContextsLinks WHERE UserID = ?', [ user[0].ID ]);
    if (rawContextsID === null) {
        return {
            action: 'login',
            content: {
                status: 1,
                user: null
            },
            callbackID: data.callbackID
        };
    }

    const contextsID = rawContextsID.map((c) => c.ContextID);
    /** @type {Array<{ ID: number, Name: string, Logo: string, Features: string }>} */
    const contexts = await database.ExecQuery(`SELECT * FROM Contexts WHERE ID IN (${contextsID.join(',')})`);
    if (contexts === null) {
        return {
            action: 'login',
            content: {
                status: 1,
                user: null
            },
            callbackID: data.callbackID
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
        action:'login',
        content: {
            status: 0,
            user: user[0]
        },
        callbackID: data.callbackID
    };
}

export { Login };
