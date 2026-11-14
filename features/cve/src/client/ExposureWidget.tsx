import { CountWidget, useResource } from 'deveye-sdk-client';

import { api } from './api';

/**
 * La carte de l'accueil : les failles ouvertes qui touchent ce que l'espace
 * fait tourner, et rien d'autre. Rouge dès qu'une est grave.
 */
export default function ExposureWidget() {
    const counts = useResource(
        'cve.exposureCount',
        () => api.send('cve.exposureCount', {}),
        'Le décompte n’a pas pu être lu.'
    );
    const data = counts.data;
    const serious = data ? data.critical + data.high : 0;
    const extras = [
        data && data.critical > 0 ? `dont ${data.critical} critique${data.critical > 1 ? 's' : ''}` : null,
        data && data.eol > 0 ? `${data.eol} fin${data.eol > 1 ? 's' : ''} de vie` : null,
        data && data.deprecated > 0 ? `${data.deprecated} dépréciée${data.deprecated > 1 ? 's' : ''}` : null
    ].filter((s): s is string => s !== null);

    return (
        <CountWidget
            state={data ? { kind: 'ready', count: data.count } : { kind: 'loading' }}
            noun='faille'
            hint={extras.length > 0 ? extras.join(' · ') : 'dans ce que l’espace fait tourner'}
            empty={
                data && data.scanned === 0
                    ? 'Aucune source analysée pour l’instant'
                    : extras.length > 0
                      ? extras.join(' · ')
                      : 'Rien de vulnérable dans ce que l’espace fait tourner'
            }
            tone={serious > 0 ? 'danger' : 'neutral'}
        />
    );
}
