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
    const { password, contextID } = data;

    if (profile.user === null) {
        return {
            status: 1,
            message: 'User not found'
        };
    }

    if (profile.user.Contexts.findIndex((c) => c.id === contextID) === -1) {
        return {
            status: 2,
            message: 'Context not found'
        };
    }

    let targetHash = '';

    if (contextID === 0) {
        const resultUser = await db.QueryPrepare(
            'SELECT `Password` FROM `Users` WHERE `ID` = ?',
            [ profile.user?.ID ]
        );
        if (resultUser === null || resultUser.length === 0) {
            return {
                status: 3,
                message: 'User not found'
            };
        }
        targetHash = resultUser[0].Password;
    } else {
        const resultContext = await db.QueryPrepare(
            'SELECT `Password` FROM `Contexts` WHERE `ID` = ?',
            [ contextID ]
        );
        if (resultContext === null || resultContext.length === 0) {
            return {
                status: 4,
                message: 'Context not found'
            };
        }
        targetHash = resultContext[0].Password;
    }

    if (targetHash.startsWith('$2y$')) {
        targetHash = '$2b$' + targetHash.substring(4);
    }

    let match = false;
    try {
        match = await bcrypt.compare(password, targetHash);
    } catch (error) {
        console.error('Login error:', error);
        return {
            status: 5,
            message: 'Error while checking password'
        };
    }

    if (!match) {
        return {
            status: 6,
            message: 'Password does not match'
        };
    }

    const indexAuth = profile.authentifications.findIndex((a) => a.contextID === contextID);
    const time = profile.user.Contexts.find((c) => c.id === contextID)?.reAuthInterval || null;
    if (indexAuth === -1) {
        profile.authentifications.push({
            contextID,
            clearPassword: password,
            passwordResetTime: Date.now() / 1000,
            resetTimeout: time === null ? null : setTimeout(() => {
                const index = profile.authentifications.findIndex((a) => a.contextID === contextID);
                if (index !== -1) {
                    profile.authentifications.splice(index, 1);
                }
            }, 1000 * time)
        });
    } else {
        if (profile.authentifications[indexAuth].resetTimeout !== null) {
            clearTimeout(profile.authentifications[indexAuth].resetTimeout);
        }
        profile.authentifications[indexAuth].clearPassword = password;
        profile.authentifications[indexAuth].passwordResetTime = Date.now() / 1000;
        profile.authentifications[indexAuth].resetTimeout = time === null ? null : setTimeout(() => {
            const index = profile.authentifications.findIndex((a) => a.contextID === contextID);
            if (index !== -1) {
                profile.authentifications.splice(index, 1);
            }
        }, 1000 * time);
    }

    return {
        status: 0,
        message: null
    };
}

export { CheckPassword };
