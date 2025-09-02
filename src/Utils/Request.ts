import type { Endpoints, EndpointTypes } from 'deveye-types';
import { env } from './Env';

const ffetch = <T extends Endpoints>(
    endpoint: T,
    requestInfo: EndpointTypes[T]['input']
): Promise<EndpointTypes[T]['output']> =>
    fetch(env.HTTP_SERVER_URL + '/' + endpoint + '.php', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestInfo)
    })
        .then((res) => res.json() as Promise<EndpointTypes[T]['output']>)
        .catch((error): EndpointTypes[T]['output'] => ({
            status: -1,
            message: error.name + ': ' + error.message,
            content: null
        }));

export { ffetch };
