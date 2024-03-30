import { StrIsJson } from '../Utils/Functions.js';

/**
 * @typedef {import('../SQL.js').default} SQL
 * @typedef {import('../Utils/Encryption.js').default} Encryption
 * @typedef {import('Types/TCP.js').SendRequestType} SendRequestType
 * @typedef {import('Types/TCP.js').ReceiveRequestType} ReceiveRequestType
 * @typedef {import('Types/Password.js').PasswordType} PasswordType
 * @typedef {import('Types/Password.js').PasswordDatabaseType} PasswordDatabaseType
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
 * @param {Encryption} crypt
 * @param {TCPRequestSendHeader<'get-passwords'>} data
 * @returns {Promise<TCPRequestReceiveHeader<'get-passwords'>>}
 */
async function GetPasswords(database, crypt, data) {
    /** @type {Array<PasswordDatabaseType>} */
    const passwords = await database.QueryPrepare('SELECT * FROM _Passwords WHERE UserID = ?', [ data.content.userID ]);
    if (passwords === null) {
        return {
            action: 'get-passwords',
            content: {
                status: 1,
                passwords: []
            },
            callbackID: data.callbackID
        };
    }

    const passwordsFormatted = passwords.map(/** @returns {PasswordType | null} */ (p) => {
        const rawContent = crypt.Decrypt(p.Content);
        if (!rawContent || !StrIsJson(rawContent)) {
            console.log('Error: Password content is not valid', rawContent);
            return null;
        }

        const content = JSON.parse(rawContent);
        if (!content.hasOwnProperty('service') || !content.hasOwnProperty('category') || !content.hasOwnProperty('email') || !content.hasOwnProperty('password') || !content.hasOwnProperty('status')) {
            console.log('Error: Password content is not valid2', content);
            return null;
        }

        const ID = p.ID;
        const { category, service, email, password: realPassword, status } = content;
        const password = !!realPassword ? '**********' : '';
        return { ID, category, service, email, password, status };
    })
    .filter((p) => p !== null);

    return {
        action: 'get-passwords',
        content: {
            status: 0,
            passwords: passwordsFormatted
        },
        callbackID: data.callbackID
    };
}

/**
 * @param {SQL} database
 * @param {Encryption} crypt
 * @param {TCPRequestSendHeader<'get-password'>} data
 * @returns {Promise<TCPRequestReceiveHeader<'get-password'>>}
 */
async function GetPassword(database, crypt, data) {
    /** @type {Array<PasswordDatabaseType>} */
    const resultPassword = await database.QueryPrepare(
        'SELECT * FROM _Passwords WHERE UserID = ? AND ID = ?',
        [ data.content.userID, data.content.passwordID ]
    );
    if (resultPassword === null || resultPassword.length === 0) {
        console.log('Error: Password not found');
        return {
            action: 'get-password',
            content: {
                status: 1,
                password: null
            },
            callbackID: data.callbackID
        };
    }

    const rawContent = crypt.Decrypt(resultPassword[0].Content);
    if (!rawContent || !StrIsJson(rawContent)) {
        console.log('Error: Password content is not valid', rawContent);
        return {
            action: 'get-password',
            content: {
                status: 1,
                password: null
            },
            callbackID: data.callbackID
        };
    }

    const content = JSON.parse(rawContent);
    if (!content.hasOwnProperty('service') || !content.hasOwnProperty('category') || !content.hasOwnProperty('email') || !content.hasOwnProperty('password') || !content.hasOwnProperty('status')) {
        console.log('Error: Password content is not valid2', content);
        return {
            action: 'get-password',
            content: {
                status: 1,
                password: null
            },
            callbackID: data.callbackID
        };
    }

    const ID = resultPassword[0].ID;
    const { category, service, email, password, status } = content;

    return {
        action: 'get-password',
        content: {
            status: 0,
            password: { ID, category, service, email, password, status }
        },
        callbackID: data.callbackID
    };
}

export { GetPasswords, GetPassword };
