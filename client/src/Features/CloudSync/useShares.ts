import { useEffect, useState } from 'react';
import type { CloudSyncShare } from 'deveye-types';

import { ws } from '@/api/ws';
import { useResourceVersion } from '@/stores/invalidation';

/**
 * Les partages de l'utilisateur, chargés dès que le socket est OUVERT (pas au
 * montage : le widget de la grille monte souvent avant la connexion — un envoi
 * à ce moment-là échoue et resterait figé). Rechargés à chaque (ré)ouverture
 * du socket et à chaque `invalidate('cloudSync.listShares')` ; un échec
 * transitoire conserve la dernière valeur au lieu d'un faux « vide ».
 */
export function useShares(): CloudSyncShare[] | null {
    const version = useResourceVersion('cloudSync.listShares');
    const [shares, setShares] = useState<CloudSyncShare[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        const load = () => {
            ws.send('cloudSync.listShares', {})
                .then((out) => {
                    if (!cancelled) setShares(out.shares);
                })
                .catch(() => {
                    // Transitoire (reconnexion…) : on garde l'état courant.
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
    }, [version]);

    return shares;
}
