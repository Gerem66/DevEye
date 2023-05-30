const featureURL = process.env.NODE_ENV === 'production' ? 'https://wyrmo.com/DevEye/server' : 'https://wyrmo.com/DevEye/server-dev';

/**
 * @typedef {'/auth'} Endpoint
 */

/**
 * @param {Endpoint} endpoint
 * @param {RequestInit} requestInfo
 * @returns {Promise<any>}
 */
const ffetch = (endpoint = '/auth', requestInfo = {}) => fetch(featureURL + endpoint + '.php', requestInfo).then(res => res.json());

export { ffetch };