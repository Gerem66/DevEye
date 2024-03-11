/**
 * @typedef {'/auth'} Endpoint
 * @typedef {import('Types/User').UserType} UserType
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
    fetch(process.env.REACT_APP_SERVER_URL + endpoint + '.php', requestInfo)
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
