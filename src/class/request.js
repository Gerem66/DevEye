const featureURL = process.env.NODE_ENV === 'production' ? 'https://wyrmo.com/DevEye/server' : 'https://wyrmo.com/DevEye/server-dev';

/**
 * @typedef {'/auth'} Endpoint
 * @typedef {import('./user').UserType} UserType
 * @typedef {any|UserType} RequestOutputTypes
 */

/**
 * @template {RequestOutputTypes} T
 * @typedef RequestResult
 * @property {number} status 0 for success
 * @property {string} message
 * @property {T} content
 */

/**
 * @template {RequestOutputTypes} T
 * @param {Endpoint} endpoint
 * @param {RequestInit} requestInfo
 * @returns {Promise<RequestResult<T>>}
 */
const ffetch = (endpoint, requestInfo = {}) => 
    fetch(featureURL + endpoint + '.php', requestInfo)
        .then(res => res.json())
        .catch((error) => {
            const output = {
                status: -1,
                message: error.name + ': ' + error.message,
                content: null
            };
            return output;
        });;

export { ffetch };