import { featureApi } from 'deveye-sdk-client';

import { manifest } from '../manifest';

/** L'envoi typé des commandes du module, partagé par toutes ses vues. */
export const api = featureApi(manifest);

/**
 * Les liens internes que les sondes émettent (`osint:domain/example.com`) : une
 * sonde ne connaît pas le client, elle émet une pseudo-URL que la carte
 * transforme en rebond vers une nouvelle recherche.
 */
export function internalPivot(href: string): string | null {
    if (!href.startsWith('osint:')) return null;
    const slash = href.indexOf('/');
    if (slash === -1) return null;
    return href.slice(slash + 1);
}
