import { useEffect, useState } from 'react';

import type { UptimePoint, UptimeRange, UptimeResolution } from '../contracts/domain';

import { api } from './api';
import { rangeWindow } from './format';

/**
 * L'historique d'un service, pour qui n'affiche que la bande d'état.
 *
 * Pas de minuteur : `stamp` reçoit `service.lastCheckedAt`, qui ne bouge que
 * pour ce service, donc une liste de vingt cartes ne relit pas vingt
 * historiques quand une seule sonde tombe. Une lecture manquée ne remonte pas
 * d'erreur : les barres se taisent, la sonde suivante les ramène.
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
                const res = await api.send('uptime.history', { id, range });
                if (!cancelled) {
                    setPoints(res.points);
                    setResolution(res.resolution);
                }
            } catch {
                // L'aperçu se tait, rien d'autre.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [id, stamp, range]);

    return { points, resolution, axis: rangeWindow(range, points) };
}

export default useServiceHistory;
