const featureURL = process.env.NODE_ENV === 'production' ? 'https://wyrmo.com/DevEye/server' : 'https://wyrmo.com/DevEye/server-dev';

/**
 * @typedef {'/'|'/auth'|'/features'} Endpoint
 */

/**
 * @param {Endpoint} endpoint
 * @param {RequestInit} requestInfo
 * @returns 
 */
const ffetch = (endpoint = '/', requestInfo = {}) => fetch(featureURL + endpoint + '.php', requestInfo).then(res => res.json());

export { ffetch };