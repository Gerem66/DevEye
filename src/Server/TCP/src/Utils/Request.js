/**
 * @typedef {import('Types/HTTP').Endpoints} Endpoints
 * @typedef {import('Types/HTTP').EndpointTypes} EndpointTypes
 */

/**
 * @template {Endpoints} T
 * @param {T} endpoint
 * @param {Object} requestInfo Data to send to the server
 * @returns {Promise<{ status: number, message: string, content: EndpointTypes[T] }>}
 */
const ffetch = (endpoint, requestInfo = {}) =>
    fetch(process.env.SERVER_URL + '/' + endpoint + '.php', {
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

/**
 * @template {keyof import('Types/TCP/TCP.js').RequestServerToClient} T
 * @typedef {import('Types/TCP/TCP.js').TCPRequestReceiveHeader<T>} TCPRequestReceiveHeader
 */

/**
 * @typedef {import('websocket').connection} WebSocketConnection
 * @typedef {import('Types/TCP/TCP.js').RequestServerToClient} RequestServerToClient
 */

/**
 * @template {keyof RequestServerToClient} T
 * @param {WebSocketConnection} c
 * @param {T} action
 * @param {TCPRequestReceiveHeader<T>} data
 */
function SendData(c, action, data) {
    void action;
    c.send(JSON.stringify(data));
}

export { ffetch, SendData };
