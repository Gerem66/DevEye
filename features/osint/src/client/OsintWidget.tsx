import { useEffect, useState } from 'react';
import {
    OSINT_PROBE_META,
    osintProbeIdSchema,
    osintProbeUsable,
    type OsintProvider,
    type OsintUsage
} from '../contracts/domain';
import { onSocketOpen, useActiveWorkspace, useResourceVersion } from 'deveye-sdk-client';

import { api } from './api';
import { usageSentence } from './QuotaNotice';
import styles from './Osint.module.css';

/**
 * Carte de la grille : les sondes prêtes, celles qui attendent une clé, nommées,
 * et les recherches du mois quand l'offre les borne. Ne dépend jamais du mot de
 * passe en cache : ni `osint.keyList` ni `osint.usage` ne rendent de requête.
 */
export function OsintWidget(): React.ReactElement {
    const workspace = useActiveWorkspace();
    const keysVersion = useResourceVersion('osint.keyList');
    const usageVersion = useResourceVersion('osint.usage');
    const [held, setHeld] = useState<ReadonlySet<OsintProvider> | null>(null);
    const [usage, setUsage] = useState<OsintUsage | null>(null);

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

    useEffect(() => {
        if (!workspace) return;
        let cancelled = false;
        const off = onSocketOpen(() => {
            api.send('osint.usage', {})
                .then((res) => {
                    if (!cancelled) setUsage(res.usage);
                })
                .catch(() => {
                    // Même règle que les clés : le dernier compte connu reste.
                });
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [workspace, usageVersion]);

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
                        {usage && <div>{usageSentence(usage)}</div>}
                    </>
                )}
            </div>
        </div>
    );
}

export default OsintWidget;
