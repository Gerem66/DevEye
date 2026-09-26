import { useEffect, useState } from 'react';
import { featureApi, invalidate, onSocketOpen, useActiveWorkspace, useResourceVersion } from 'deveye-sdk-client';
import type { FinanceSummary } from '../contracts/domain';

import { manifest } from '../manifest';

/** L'envoi typé des commandes du module, partagé par toutes ses vues. */
export const api = featureApi(manifest);

/**
 * Toutes les clés que remue une écriture : une dépense change le journal, un
 * solde, l'accueil de la feature et sa carte sur l'accueil de l'app.
 */
export function refreshFinance(): void {
    invalidate(
        'finance.summary',
        'finance.accountList',
        'finance.transactionList',
        'finance.overview',
        'finance.recurringList',
        'finance.statementList',
        'finance.ruleList',
        'finance.connectionList'
    );
}

/**
 * Le résumé de la carte de l'accueil. Pas `useWorkspaceCount` : il n'accepte
 * que les commandes rendant `{ count }`. Relit à l'ouverture de la socket et à
 * chaque invalidation de `finance.summary`.
 */
export function useFinanceSummary(): { summary: FinanceSummary | null; loading: boolean } {
    const workspace = useActiveWorkspace();
    const version = useResourceVersion('finance.summary');
    const [summary, setSummary] = useState<FinanceSummary | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!workspace) return;
        let cancelled = false;

        // Chargé à l'ouverture de la socket (tout de suite si elle l'est déjà),
        // et rechargé à chaque reconnexion : la primitive du SDK fait les deux.
        const off = onSocketOpen(() => {
            api.send('finance.summary', {})
                .then((res) => {
                    if (cancelled) return;
                    setSummary(res.summary);
                    setLoading(false);
                })
                .catch(() => {
                    // Une coupure passagère ne touche à rien : la dernière valeur
                    // reste, la reconnexion relira. Un zéro serait un solde faux.
                });
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [workspace, version]);

    return { summary, loading };
}
