const defaultHeaders = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
};

class ReqResponse {
    /**
     * @readonly
     * @property {Number} status - The status of the request.
     */
    status = null;

    /**
     * @readonly
     * @property {Object} data - The data of the request or error information if failed.
     */
    content = null;
}

/**
 * @param {String} url
 * @param {Object} [data={}]
 * @param {'GET' | 'POST'} [method='POST']
 * @param {Object} [headers] - Default :
 * {'Accept': 'application/json', 'Content-Type': 'application/json'}
 * @returns {Promise<ReqResponse>}
 */
async function Request_Async(url, data = {}, method = 'POST', headers = defaultHeaders) {
    let reqResponse = new ReqResponse();

    const header = {
        method: method,
        headers: headers,
        body: JSON.stringify(data)
    };

    try {
        const request = await fetch(url, header);
        reqResponse.status = request.status;
        if (request.status === 200) {
            const response = await request.json();
            reqResponse.content = response;
        } else {
            reqResponse.content = { error: request.statusText };
        }
    } catch (err) {
        reqResponse.status = 1;
        reqResponse.content = { error: err };
    }

    return reqResponse;
}