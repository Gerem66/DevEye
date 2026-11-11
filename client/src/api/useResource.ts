import { useCallback, useEffect, useState } from 'react';

import { ws } from '@/api/ws';
import type { ErrorNoteInput } from '@/Components/ErrorNote';
import { useResourceVersion, type ResourceKey } from '@/stores/invalidation';
import { UploadError } from '@/upload';
import { humanizeError } from './humanizeError';

/**
 * Un échec tel que `ErrorNote` le montre : la phrase, et le code qui décide du
 * signalement. Le code est lu sur la forme, sans `instanceof` : un module et
 * l'app peuvent résoudre deux classes d'erreur distinctes. Un envoi refusé
 * garde la phrase du module qui a reçu le fichier.
 */
export function errorNote(error: unknown, fallback: string): ErrorNoteInput {
    const raw = (error as { code?: unknown } | null)?.code;
    const code = typeof raw === 'string' ? raw : null;
    if (error instanceof UploadError && code !== 'internal') return { message: error.message, code };
    // Le rejet qu'une opération longue écrit elle-même (coupure, silence) dit déjà quoi faire.
    if ((error as { name?: unknown } | null)?.name === 'TaskError') return { message: (error as Error).message, code };
    return { message: humanizeError(error, fallback), code };
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
): { data: T | null; error: ErrorNoteInput | null; loading: boolean; reload: () => void } {
    const version = useResourceVersion(key);
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
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
                    setError(errorNote(e, fallback));
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
