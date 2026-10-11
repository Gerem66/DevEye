import { CountWidget, useResource } from 'deveye-sdk-client';

import { api } from './api';
import { plural } from './format';

/** La carte de l'accueil : les liens, et les visites du jour. */
export default function ShortlinksWidget() {
    const counts = useResource(
        'shortlinks.count',
        () => api.send('shortlinks.count', {}),
        'Les liens n’ont pas pu être comptés.'
    );
    const data = counts.data;
    return (
        <CountWidget
            state={data === null ? { kind: 'loading' } : { kind: 'ready', count: data.total }}
            noun='lien'
            hint={data === null ? '' : `${plural(data.visitsToday, 'visite', 'visites')} aujourd’hui`}
            empty='Aucun lien court'
        />
    );
}
