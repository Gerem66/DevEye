import { useCallback, useEffect, useState } from 'react';

import { ws } from '@/api/ws';
import type { ErrorNoteInput } from '@/Components/ErrorNote';
import { useResourceVersion, type ResourceKey } from '@/stores/invalidation';
import { UploadError } from '@/upload';

/**
 * Traduit un échec en une phrase courte pour un bandeau d'erreur. Lu sur la
 * forme (`code`, `message`) : une `WsError`, une `ApiError` ou le refus d'une
 * image parlent la même langue.
 */
export function humanizeError(error: unknown, fallback: string): string {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    if (typeof code !== 'string' || typeof message !== 'string') return fallback;
    // Celui qui refuse a déjà écrit une phrase en français sur ces codes,
    // plus précise que tout ce qu'on pourrait écrire ici.
    if (
        code === 'validation' ||
        code === 'conflict' ||
        code === 'forbidden' ||
        code === 'rate_limited' ||
        code === 'quota_exceeded'
    ) {
        return message || (code === 'forbidden' ? 'Accès refusé.' : fallback);
    }
    if (code === 'not_found') return 'Introuvable: la donnée a peut-être été supprimée entre-temps.';
    if (code === 'locked') return 'Déverrouillage requis.';
    if (code === 'timeout') return 'Délai dépassé.';
    return fallback;
}

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
