/**
 * @typedef {import('Types/User').UserType} UserType
 * 
 * @typedef {'auth' | 'auto-login'} Endpoints
 * 
 * @typedef {object} EndpointTypes
 * @property {string} auth
 * @property {null} auto-login
 */

/**
 * @template {Endpoints} T
 * @param {T} endpoint
 * @param {Object} requestInfo Data to send to the server
 * @returns {Promise<{ status: number, message: string, content: EndpointTypes[T] }>}
 */
const ffetch = (endpoint, requestInfo = {}) =>
    fetch(process.env.REACT_APP_SERVER_URL + '/' + endpoint + '.php', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestInfo)
    })
        .then(res => res.json())
        .catch((error) => {
            return {
                status: -1,
                message: error.name + ': ' + error.message,
                content: null
            };
        });

export { ffetch };
