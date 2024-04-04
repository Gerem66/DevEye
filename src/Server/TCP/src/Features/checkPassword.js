import bcrypt from 'bcrypt';

/**
 * @typedef {import('./types.js').RequestTypes} RequestTypes
 */

/**
 * @template {RequestTypes} T
 * @typedef {import('./types.js').TCPFeatureType<T>} TCPFeatureType
 */

/** @type {TCPFeatureType<'check-password'>} */
async function CheckPassword({ db, profile, data }) {
    const { password } = data;

    const resultUser = await db.QueryPrepare(
        'SELECT `Password` FROM `Users` WHERE `ID` = ?',
        [ profile.user?.ID ]
    );
    if (resultUser === null || resultUser.length === 0) {
        return {
            status: 1,
            message: 'User not found'
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
        match = await bcrypt.compare(password, userPassword);
    } catch (error) {
        console.error('Login error:', error);
        return {
            status: 2,
            message: 'Error while checking password'
        };
    }

    if (!match) {
        return {
            status: 3,
            message: 'Password does not match'
        };
    }

    return {
        status: 0,
        message: null
    };
}

export { CheckPassword };
