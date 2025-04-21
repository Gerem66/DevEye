/**
 * @typedef {import('Types/HTTP').Endpoints} Endpoints
 * @typedef {import('Types/HTTP').EndpointTypes} EndpointTypes
 */

// TODO: Remove
/**
 * @template {Endpoints} T
 * @param {T} endpoint
 * @param {Object} requestInfo Data to send to the server
 * @returns {Promise<{ status: number, message: string, content: EndpointTypes[T] }>}
 * @deprecated
 */
const ffetch = (endpoint, requestInfo = {}) =>
    fetch(process.env.REACT_APP_SERVER_URL + '/' + endpoint + '.php', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestInfo)
    })
        .then((res) => res.json())
        .catch((error) => {
            return {
                status: -1,
                message: error.name + ': ' + error.message,
                content: null
            };
        });

export { ffetch };
