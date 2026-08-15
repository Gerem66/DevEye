import { useEffect, useState } from 'react';

import { ws } from '@/api/ws';

import { rangeWindow } from './format';

import type { UptimePoint, UptimeRange, UptimeResolution } from 'deveye-types';

/**
 * L'historique d'un service, pour qui n'affiche que la bande d'état.
 *
 * **Pas de minuteur : `stamp`.** On lui passe `service.lastCheckedAt`, qui bouge
 * à chaque sonde — c'est ce qui rafraîchit les barres. Et parce qu'il ne bouge
 * que pour *ce* service, une liste de vingt cartes ne relit pas vingt historiques
 * quand une seule sonde tombe : seule la carte concernée repart.
 *
 * Une lecture manquée ne remonte pas d'erreur. Ce n'est jamais la raison d'être
 * de l'endroit qui l'appelle — il reste le nom, l'état, les chiffres — et une
 * bannière rouge pour un aperçu absent coûterait plus qu'elle ne rapporte. Les
 * barres se taisent, la sonde suivante les ramène.
 */
export function useServiceHistory(
    id: number,
    stamp: number | null,
    range: UptimeRange = '24h'
): { points: UptimePoint[]; resolution: UptimeResolution; axis: { from: number; to: number } } {
    const [points, setPoints] = useState<UptimePoint[]>([]);
    const [resolution, setResolution] = useState<UptimeResolution>('raw');

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await ws.send('uptime.history', { id, range });
                if (!cancelled) {
                    setPoints(res.points);
                    setResolution(res.resolution);
                }
            } catch {
                // Voir le commentaire de tête : l'aperçu se tait, rien d'autre.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [id, stamp, range]);

    return { points, resolution, axis: rangeWindow(range, points) };
}

export default useServiceHistory;
