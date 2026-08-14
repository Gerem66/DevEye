import { useEffect, useState } from 'react';

import { ws } from '@/api/ws';
import { useActiveWorkspace } from '@/stores/workspace';

import styles from './Osint.module.css';

/**
 * Carte de la grille : combien de sondes sont opérationnelles, et combien de
 * clés fournisseurs restent à poser.
 *
 * Ne dépend **jamais** du mot de passe en cache, à la différence de l'ancienne
 * version (dernière cible cherchée, nombre de recherches récentes) : ces deux-là
 * exigeaient le coffre déverrouillé pour se déchiffrer, donc la vignette
 * changeait de contenu selon qu'on venait d'ouvrir la session ailleurs — un état
 * qui n'a rien à faire sur une carte d'accueil. `osint.keyList` ne rend qu'un
 * booléen par fournisseur (la clé elle-même ne sort jamais), donc les deux
 * comptes sont toujours les mêmes, verrouillé ou non.
 *
 * Les deux nombres répondent à deux questions différentes, d'où les montrer
 * tous les deux plutôt que d'en choisir un. Le compte de sondes part du
 * **registre des sondes** : la plupart (DNS, WHOIS, TLS, crt.sh…) ne demandent
 * aucune clé et répondent déjà à froid, donc il reste élevé même sur un espace
 * tout neuf — il ne dit pas « qu'est-ce qu'il me reste à poser ? ». C'est le
 * compte de clés qui répond à celle-là, sur le total des fournisseurs proposés
 * dans les réglages.
 */
export function OsintWidget(): React.ReactElement {
    const workspace = useActiveWorkspace();
    const [counts, setCounts] = useState<{
        probesAvailable: number;
        probesTotal: number;
        keysHeld: number;
        keysTotal: number;
    } | null>(null);

    useEffect(() => {
        if (!workspace) return;
        let cancelled = false;

        const load = (): void => {
            ws.send('osint.keyList', {})
                .then((res) => {
                    if (cancelled) return;
                    setCounts({
                        probesAvailable: res.probesAvailable,
                        probesTotal: res.probesTotal,
                        keysHeld: res.providers.filter((p) => p.hasKey).length,
                        keysTotal: res.providers.length
                    });
                })
                .catch(() => {
                    // Un échec passager garde le dernier compte connu plutôt
                    // que de retomber sur un « 0 » trompeur.
                });
        };

        if (ws.state === 'open') load();
        const off = ws.onStateChange((s) => {
            if (s === 'open') load();
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [workspace]);

    return (
        <div className={styles.widget}>
            <div className={styles.widgetMuted}>
                {counts === null ? (
                    'Chargement…'
                ) : (
                    <>
                        <div>
                            {counts.probesAvailable} sonde{counts.probesAvailable > 1 ? 's' : ''} sur{' '}
                            {counts.probesTotal} disponible{counts.probesAvailable > 1 ? 's' : ''}
                        </div>
                        <div>
                            {counts.keysHeld} clé{counts.keysHeld > 1 ? 's' : ''} sur {counts.keysTotal} configurée
                            {counts.keysHeld > 1 ? 's' : ''}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

export default OsintWidget;
