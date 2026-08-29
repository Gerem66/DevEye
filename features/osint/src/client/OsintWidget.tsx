import { useEffect, useState } from 'react';
import { onSocketOpen, useActiveWorkspace } from 'deveye-sdk-client';

import { api } from './api';
import styles from './Osint.module.css';

/**
 * Carte de la grille : sondes opérationnelles, et clés fournisseurs restant à
 * poser. Ne dépend jamais du mot de passe en cache : `osint.keyList` ne rend
 * qu'un booléen par fournisseur, donc les deux comptes sont les mêmes,
 * verrouillé ou non.
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

        // Chargée à l'ouverture de la socket (tout de suite si elle l'est déjà),
        // et rechargée à chaque reconnexion : la primitive du SDK fait les deux.
        const off = onSocketOpen(() => {
            api.send('osint.keyList', {})
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
