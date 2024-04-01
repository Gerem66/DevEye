import bcrypt from 'bcrypt';

/**
 * @typedef {import('../SQL.js').default} SQL
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
 * @param {TCPRequestSendHeader<'check-password'>} data
 * @returns {Promise<TCPRequestReceiveHeader<'check-password'>>}
 */
async function CheckPassword(db, data) {
    const resultUser = await db.QueryPrepare('SELECT `Password` FROM `Users` WHERE `ID` = ?', [ data.content.userID ]);
    if (resultUser === null || resultUser.length === 0) {
        return {
            action: 'check-password',
            content: {
                status: 1,
                message: 'User not found'
            },
            callbackID: data.callbackID
        };
    }

    const rawUser = resultUser[0];

    /** @type {string} */
    let userPassword = rawUser['Password'];
    if (userPassword.startsWith('$2y$')) {
        userPassword = '$2b$' + userPassword.substring(4);
    }

    let match = false;
    try {
        match = await bcrypt.compare(data.content.password, userPassword);
    } catch (error) {
        console.error('Login error:', error);
        return {
            action: 'check-password',
            content: {
                status: 2,
                message: 'Error while checking password'
            },
            callbackID: data.callbackID
        };
    }

    if (!match) {
        return {
            action: 'check-password',
            content: {
                status: 3,
                message: 'Password does not match'
            },
            callbackID: data.callbackID
        };
    }

    return {
        action: 'check-password',
        content: {
            status: 0,
            message: null
        },
        callbackID: data.callbackID
    };
}

export { CheckPassword };
