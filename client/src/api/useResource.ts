import { useCallback, useEffect, useState } from 'react';

import { ws, WsError } from '@/api/ws';
import { useResourceVersion, type ResourceKey } from '@/stores/invalidation';

/** Traduit un échec WS en une phrase courte pour un bandeau d'erreur. */
export function humanizeError(error: unknown, fallback: string): string {
    if (error instanceof WsError) {
        if (error.code === 'forbidden') return 'Accès refusé.';
        // Le serveur renvoie déjà une phrase en français sur ces deux codes, plus
        // précise que tout ce qu'on pourrait écrire ici.
        if (error.code === 'validation' || error.code === 'conflict') return error.message;
        if (error.code === 'not_found') return 'Introuvable: la donnée a peut-être été supprimée entre-temps.';
        if (error.code === 'locked') return 'Déverrouillage requis.';
        if (error.code === 'timeout') return 'Délai dépassé.';
    }
    return fallback;
}

/**
 * Un chargement qui se relit tout seul, le hook de données des features.
 *
 * Trois déclencheurs, et pas un de plus: le montage, la (re)connexion de la
 * socket, et l'invalidation de la ressource (locale après une écriture, ou
 * distante quand quelqu'un d'autre écrit dans l'espace). Aucun minuteur: une
 * donnée d'espace ne bouge que si quelqu'un l'écrit, et il le dit.
 */
export function useResource<T>(
    key: ResourceKey,
    load: () => Promise<T>,
    fallback: string,
    /** Ce qui, en changeant, change la requête elle-même (filtres, fenêtre). */
    deps: readonly unknown[] = []
): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
    const version = useResourceVersion(key);
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [nonce, setNonce] = useState(0);

    const reload = useCallback(() => setNonce((n) => n + 1), []);

    useEffect(() => {
        let cancelled = false;

        const run = () => {
            load()
                .then((next) => {
                    if (cancelled) return;
                    setData(next);
                    setError(null);
                    setLoading(false);
                })
                .catch((e: unknown) => {
                    if (cancelled) return;
                    setError(humanizeError(e, fallback));
                    setLoading(false);
                });
        };

        if (ws.state === 'open') run();
        const off = ws.onStateChange((state) => {
            if (state === 'open') run();
        });
        return () => {
            cancelled = true;
            off();
        };
        // `load` est recréé à chaque rendu par ses appelants, qui capturent des
        // filtres: l'inscrire ici relancerait la requête en boucle. Seuls `version`,
        // `nonce` et les dépendances annoncées décident de relire.
    }, [version, nonce, ...deps]);

    return { data, error, loading, reload };
}
