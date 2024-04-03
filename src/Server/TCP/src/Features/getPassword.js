import { StrIsJson } from '../Utils/Functions.js';

/**
 * @typedef {import('./types.js').RequestTypes} RequestTypes
 * @typedef {import('Types/Password.js').PasswordType} PasswordType
 * @typedef {import('Types/Password.js').PasswordDatabaseType} PasswordDatabaseType
 */

/**
 * @template {RequestTypes} T
 * @typedef {import('./types.js').TCPFeatureType<T>} TCPFeatureType
 */

/** @type {TCPFeatureType<'get-passwords'>} */
async function GetPasswords({ db, crypt, profile, data }) {
    const { contextID } = data;

    /** @type {Array<PasswordDatabaseType> | null} */
    let passwords = null;

    if (contextID === 0) {
        passwords = await db.QueryPrepare(
            'SELECT * FROM _Passwords WHERE UserID = ? AND ContextID IS NULL',
            [ profile.user?.ID ]
        );
    } else {
        passwords = await db.QueryPrepare(
            'SELECT * FROM _Passwords WHERE UserID = ? AND ContextID = ?',
            [ profile.user?.ID, contextID ]
        );
    }

    if (passwords === null) {
        return {
            status: 1,
            passwords: []
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
        status: 0,
        passwords: passwordsFormatted
    };
}

/** @type {TCPFeatureType<'get-password'>} */
async function GetPassword({ db, crypt, profile, data }) {
    const { contextID, passwordID } = data;

    /** @type {Array<PasswordDatabaseType> | null} */
    let resultPassword = null;

    if (contextID === 0) {
        resultPassword = await db.QueryPrepare(
            'SELECT * FROM _Passwords WHERE ID = ? AND UserID = ? AND ContextID IS NULL',
            [ passwordID, profile.user?.ID ]
        );
    } else {
        resultPassword = await db.QueryPrepare(
            'SELECT * FROM _Passwords WHERE ID = ? AND UserID = ? AND ContextID = ?',
            [ passwordID, profile.user?.ID, contextID ]
        );
    }

    if (resultPassword === null || resultPassword.length === 0) {
        console.log('Error: Password not found');
        return {
            status: 1,
            password: null
        };
    }

    const rawContent = crypt.Decrypt(resultPassword[0].Content);
    if (!rawContent || !StrIsJson(rawContent)) {
        console.log('Error: Password content is not valid', rawContent);
        return {
            status: 1,
            password: null
        };
    }

    const content = JSON.parse(rawContent);
    if (!content.hasOwnProperty('service') || !content.hasOwnProperty('category') || !content.hasOwnProperty('email') || !content.hasOwnProperty('password') || !content.hasOwnProperty('status')) {
        console.log('Error: Password content is not valid2', content);
        return {
            status: 1,
            password: null
        };
    }

    return {
        status: 0,
        password: {
            ID: resultPassword[0].ID,
            category: content.category,
            service: content.service,
            email: content.email,
            password: content.password,
            status: content.status
        }
    };
}

export { GetPasswords, GetPassword };
