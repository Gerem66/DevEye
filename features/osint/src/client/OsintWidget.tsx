import { useEffect, useState } from 'react';
import { OSINT_PROBE_META, osintProbeIdSchema, osintProbeUsable, type OsintProvider } from '../contracts/domain';
import { onSocketOpen, useActiveWorkspace, useResourceVersion } from 'deveye-sdk-client';

import { api } from './api';
import styles from './Osint.module.css';

/**
 * Carte de la grille : les sondes prêtes, et celles qui attendent une clé,
 * nommées. Ne dépend jamais du mot de passe en cache : `osint.keyList` ne rend
 * qu'un booléen par fournisseur, donc le compte est le même, verrouillé ou non.
 */
export function OsintWidget(): React.ReactElement {
    const workspace = useActiveWorkspace();
    const keysVersion = useResourceVersion('osint.keyList');
    const [held, setHeld] = useState<ReadonlySet<OsintProvider> | null>(null);

    useEffect(() => {
        if (!workspace) return;
        let cancelled = false;

        // Chargée à l'ouverture de la socket (tout de suite si elle l'est déjà),
        // et rechargée à chaque reconnexion : la primitive du SDK fait les deux.
        const off = onSocketOpen(() => {
            api.send('osint.keyList', {})
                .then((res) => {
                    if (!cancelled) setHeld(new Set(res.providers.filter((p) => p.hasKey).map((p) => p.provider)));
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
    }, [workspace, keysVersion]);

    const probes = osintProbeIdSchema.options;
    const blocked = held ? probes.filter((p) => !osintProbeUsable(p, held)) : [];

    return (
        <div className={styles.widget}>
            <div className={styles.widgetMuted}>
                {held === null ? (
                    'Chargement…'
                ) : (
                    <>
                        <div>
                            {probes.length - blocked.length} sondes prêtes sur {probes.length}
                        </div>
                        <div>
                            {blocked.length === 0
                                ? 'Aucune n’attend de clé'
                                : `En attente d’une clé : ${blocked.map((p) => OSINT_PROBE_META[p].label).join(', ')}`}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

export default OsintWidget;
