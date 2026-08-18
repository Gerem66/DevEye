import { useCallback, useEffect, useState } from 'react';
import type { FinanceSummary } from 'deveye-types';

import { ws, WsError } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { useActiveWorkspace } from '@/stores/workspace';

/**
 * Le raccordement des finances au reste de l'application.
 *
 * Une écriture des finances touche **plusieurs** vues à la fois: enregistrer une
 * dépense change le journal, le solde du compte, le tableau de bord, un budget,
 * et la carte de l'accueil. Plutôt que de laisser chaque appelant se souvenir de
 * cette liste, `refreshFinance()` la porte une fois pour toutes, et s'appelle
 * juste après l'appel WS qui a réussi.
 */

/** Toutes les clés que remue une écriture des finances. */
export function refreshFinance(): void {
    invalidate('finance.summary');
    invalidate('finance.accountList');
    invalidate('finance.transactionList');
    invalidate('finance.overview');
    invalidate('finance.budgetList');
    invalidate('finance.recurringList');
}

/** Traduit un échec WS en une phrase courte pour un bandeau d'erreur. */
export function humanizeError(error: unknown, fallback: string): string {
    if (error instanceof WsError) {
        if (error.code === 'forbidden') return 'Accès refusé.';
        // Le serveur renvoie déjà une phrase en français sur ces deux codes, et
        // elle est plus précise que tout ce qu'on pourrait écrire ici (quel
        // compte, combien d'opérations, quelle date déjà prise).
        if (error.code === 'validation' || error.code === 'conflict') return error.message;
        if (error.code === 'not_found') return 'Introuvable: la donnée a peut-être été supprimée entre-temps.';
    }
    return fallback;
}

/**
 * Le résumé lu par la carte de l'accueil.
 *
 * Même forme que `useWorkspaceCount`, dont il ne peut pas se servir: celui-là
 * n'accepte que les commandes rendant `{ count }`, et une carte de finances qui
 * annoncerait « 3 comptes » ne dirait rien de ce qu'on vient y chercher. Il
 * relit à l'ouverture de la socket et à chaque invalidation de `finance.summary`,
 * exactement comme lui.
 */
export function useFinanceSummary(): { summary: FinanceSummary | null; loading: boolean } {
    const workspace = useActiveWorkspace();
    const version = useResourceVersion('finance.summary');
    const [summary, setSummary] = useState<FinanceSummary | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!workspace) return;
        let cancelled = false;

        const load = () => {
            ws.send('finance.summary', {})
                .then((res) => {
                    if (cancelled) return;
                    setSummary(res.summary);
                    setLoading(false);
                })
                .catch(() => {
                    // Une coupure passagère ne touche à rien: la dernière valeur
                    // connue reste affichée, et la reconnexion relira. Retomber à
                    // zéro afficherait un solde faux, ce qui est bien pire que
                    // d'afficher un solde d'il y a une minute.
                });
        };

        if (ws.state === 'open') load();
        const off = ws.onStateChange((state) => {
            if (state === 'open') load();
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [workspace, version]);

    return { summary, loading };
}

/**
 * Un chargement qui se relit tout seul.
 *
 * Trois déclencheurs, et pas un de plus: le montage, la (re)connexion de la
 * socket, et l'invalidation de la ressource (locale après une écriture, ou
 * distante quand quelqu'un d'autre écrit dans l'espace). Aucun minuteur: un
 * livre de comptes ne bouge que si quelqu'un l'écrit, et il le dit.
 */
export function useFinanceResource<T>(
    key: Parameters<typeof useResourceVersion>[0],
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
        // `load` est recréé à chaque rendu par ses appelants (il capture des
        // filtres): l'inscrire ici relancerait la requête en boucle. Ce sont
        // `version`, `nonce` et les dépendances annoncées qui décident de
        // relire, et elles seules.
    }, [version, nonce, ...deps]);

    return { data, error, loading, reload };
}
