import { StrIsJson } from '@/Utils/Types';
import { Unlock } from './unlock.js';

/**
 * @typedef {import('deveye-types').RequestCommands} RequestCommands
 * @typedef {import('Types/Password.js').PasswordType} PasswordType
 * @typedef {import('Types/Password.js').PasswordDatabaseType} PasswordDatabaseType
 */

/**
 * @template {RequestCommands} T
 * @typedef {import('./types.js').TCPFeatureType<T>} TCPFeatureType
 */

/** @type {TCPFeatureType<'get-passwords'>} */
async function GetPasswords({ db, crypt, profile, data }) {
    const { contextID } = data;

    /** @type {Array<PasswordDatabaseType> | null} */
    let passwords = null;

    if (contextID === 0) {
        passwords = await db.QueryPrepare('SELECT * FROM _Passwords WHERE UserID = ? AND ContextID IS NULL', [
            profile.user?.ID
        ]);
    } else {
        passwords = await db.QueryPrepare('SELECT * FROM _Passwords WHERE ContextID = ?', [contextID]);
    }

    if (passwords === null) {
        return {
            status: 1,
            passwords: []
        };
    }

    const passwordsFormatted = passwords
        .map(
            /** @returns {PasswordType | null} */ (p) => {
                const rawContent = crypt.Decrypt(p.Content);
                if (!rawContent || !StrIsJson(rawContent)) {
                    console.log('Error: Password content is not valid', rawContent);
                    return null;
                }

                const content = JSON.parse(rawContent);
                if (
                    !Object.prototype.hasOwnProperty.call(content, 'service') ||
                    !Object.prototype.hasOwnProperty.call(content, 'category') ||
                    !Object.prototype.hasOwnProperty.call(content, 'email') ||
                    !Object.prototype.hasOwnProperty.call(content, 'password') ||
                    !Object.prototype.hasOwnProperty.call(content, 'status')
                ) {
                    console.log('Error: Password content is not valid2', content);
                    return null;
                }

                const ID = p.ID;
                const { category, service, email, password: realPassword, status } = content;
                const password = realPassword ? '**********' : '';
                return { ID, category, service, email, password, status };
            }
        )
        .filter((p) => p !== null);

    return {
        status: 0,
        passwords: passwordsFormatted
    };
}

/** @type {TCPFeatureType<'get-password'>} */
async function GetPassword({ db, crypt, profile, data }) {
    const { contextID, passwordID } = data;

    const unlockStatus = await Unlock(db, profile, contextID);
    if (unlockStatus === 'error') {
        return {
            status: 1,
            password: null
        };
    }
    if (unlockStatus !== 'unlocked') {
        return {
            status: 2,
            password: null
        };
    }

    /** @type {Array<PasswordDatabaseType> | null} */
    let resultPassword = null;

    if (contextID === 0) {
        resultPassword = await db.QueryPrepare(
            'SELECT * FROM _Passwords WHERE ID = ? AND UserID = ? AND ContextID IS NULL',
            [passwordID, profile.user?.ID]
        );
    } else {
        resultPassword = await db.QueryPrepare('SELECT * FROM _Passwords WHERE ID = ? AND ContextID = ?', [
            passwordID,
            contextID
        ]);
    }

    if (resultPassword === null || resultPassword.length === 0) {
        console.log('Error: Password not found');
        return {
            status: 3,
            password: null
        };
    }

    const rawContent = crypt.Decrypt(resultPassword[0].Content);
    if (!rawContent || !StrIsJson(rawContent)) {
        console.log('Error: Password content is not valid', rawContent);
        return {
            status: 4,
            password: null
        };
    }

    const content = JSON.parse(rawContent);
    if (
        !Object.prototype.hasOwnProperty.call(content, 'service') ||
        !Object.prototype.hasOwnProperty.call(content, 'category') ||
        !Object.prototype.hasOwnProperty.call(content, 'email') ||
        !Object.prototype.hasOwnProperty.call(content, 'password') ||
        !Object.prototype.hasOwnProperty.call(content, 'status')
    ) {
        console.log('Error: Password content is not valid2', content);
        return {
            status: 5,
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
