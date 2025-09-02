import type { Endpoints, EndpointTypes } from 'deveye-types';

const ffetch = <T extends Endpoints>(
    endpoint: T,
    requestInfo: EndpointTypes[T]['input']
): Promise<EndpointTypes[T]['output']> =>
    fetch(import.meta.env.VITE_SERVER_URL + '/' + endpoint + '.php', {
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
