import { useCallback, useEffect, useState } from 'react';
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
export function useShares(): {
    shares: CloudSyncShare[] | null;
    /**
     * Réordonne la liste SUR PLACE, sans aller-retour : la carte se déplace sous
     * le clic au lieu d'attendre le serveur. Volontairement appliqué à l'état du
     * hook plutôt qu'à une copie tenue par l'appelant — une seconde liste
     * dériverait de celle-ci dès le prochain rechargement.
     */
    applyOrder: (ids: number[]) => void;
} {
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

    const applyOrder = useCallback((ids: number[]) => {
        setShares((prev) => {
            if (prev === null) return prev;
            const byId = new Map(prev.map((s) => [s.id, s]));
            // `flatMap` sur une recherche : un identifiant devenu inconnu (partage
            // supprimé entre-temps) disparaît au lieu de laisser un trou.
            const next = ids.flatMap((id) => byId.get(id) ?? []);
            // Et ce que `ids` ne nomme pas reste : mieux vaut une carte à sa
            // place d'origine qu'une carte évaporée par un ordre incomplet.
            for (const share of prev) if (!ids.includes(share.id)) next.push(share);
            return next;
        });
    }, []);

    return { shares, applyOrder };
}
