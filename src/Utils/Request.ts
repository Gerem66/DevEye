import type { Endpoints, EndpointTypes } from 'deveye-types';

// TODO: Remove
/**
 * @deprecated
 */
const ffetch = <T extends Endpoints>(
    endpoint: T,
    requestInfo: object = {}
): Promise<{ status: number; message: string; content: EndpointTypes[T] }> =>
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
