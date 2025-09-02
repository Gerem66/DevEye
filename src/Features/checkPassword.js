import { Unlock } from './unlock.js';

/**
 * @typedef {import('deveye-types').RequestCommands} RequestCommands
 */

/**
 * @template {RequestCommands} T
 * @typedef {import('./types.js').TCPFeatureType<T>} TCPFeatureType
 */

/** @type {TCPFeatureType<'check-password'>} */
async function CheckPassword({ db, profile, data }) {
    const { password, contextID } = data;

    const unlockStatus = await Unlock(db, profile, contextID, password);
    if (unlockStatus === 'error') {
        return {
            status: 1,
            message: 'Une erreur est survenue'
        };
    }
    if (unlockStatus !== 'unlocked') {
        return {
            status: 2,
            message: 'Mot de passe incorrect'
        };
    }

    return {
        status: 0,
        message: null
    };
}

export { CheckPassword };
