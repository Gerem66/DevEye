/**
 * @typedef {import('../SQL.js').default} SQL
 * @typedef {import('../Server.js').ProfileType} ProfileType
 * @typedef {import('../Utils/Encryption.js').default} Encryption
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
 * @param {SQL} db
 * @param {Encryption} crypt
 * @param {ProfileType} profile
 * @param {TCPRequestSendHeader<'add-context'>} data
 * @returns {Promise<TCPRequestReceiveHeader<'add-context'>>}
 */
async function AddContext(db, crypt, profile, data) {
    const { contextName } = data.content;

    if (profile.user === null) {
        return {
            action: 'add-context',
            content: {
                status: 1,
                context: null
            },
            callbackID: data.callbackID
        };
    }

    const result = await db.QueryPrepare(
        'INSERT INTO Contexts SET `Name` = ?',
        [ contextName ]
    );

    if (result === null) {
        return {
            action: 'add-context',
            content: {
                status: 2,
                context: null
            },
            callbackID: data.callbackID
        };
    }

    const context = await db.QueryPrepare(
        'SELECT * FROM Contexts WHERE `ID` = ?',
        [ result.insertId ]
    );
    if (context === null || context.length === 0) {
        return {
            action: 'add-context',
            content: {
                status: 3,
                context: null
            },
            callbackID: data.callbackID
        };
    }

    const resultLink = await db.QueryPrepare(
        'INSERT INTO ContextsLinks SET `UserID` = ?, `ContextID` = ?',
        [ profile.user.ID, context[0].ID ]
    );

    if (resultLink === null) {
        return {
            action: 'add-context',
            content: {
                status: 4,
                context: null
            },
            callbackID: data.callbackID
        };
    }

    return {
        action: 'add-context',
        content: {
            status: 0,
            context: {
                id: context[0].ID,
                name: context[0].Name,
                logo: context[0].Logo,
                features: JSON.parse(context[0].Features)
            }
        },
        callbackID: data.callbackID
    };
}

export { AddContext };
