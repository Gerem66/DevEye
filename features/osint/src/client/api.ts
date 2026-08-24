import { featureApi } from 'deveye-sdk-client';

import { manifest } from '../manifest';

/** L'envoi typé des commandes du module, partagé par toutes ses vues. */
export const api = featureApi(manifest);

/**
 * Les liens internes que les sondes émettent (`osint:domain/example.com`).
 *
 * Une sonde ne connaît pas le client : elle ne peut pas fabriquer un
 * gestionnaire de clic. Elle émet donc une pseudo-URL, que la carte reconnaît
 * ici pour en faire un rebond vers une nouvelle recherche plutôt qu'un lien
 * sortant mort. C'est ce qui rend les adresses d'un DNS et les noms d'un
 * certificat directement cliquables.
 */
export function internalPivot(href: string): string | null {
    if (!href.startsWith('osint:')) return null;
    const slash = href.indexOf('/');
    if (slash === -1) return null;
    return href.slice(slash + 1);
}
