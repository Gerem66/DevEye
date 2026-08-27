import { useEffect, useState } from 'react';
import { featureApi, invalidate, onSocketOpen, useActiveWorkspace, useResourceVersion } from 'deveye-sdk-client';
import type { FinanceSummary } from '../contracts/domain';

import { manifest } from '../manifest';

/** L'envoi typé des commandes du module, partagé par toutes ses vues. */
export const api = featureApi(manifest);

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
    invalidate(
        'finance.summary',
        'finance.accountList',
        'finance.transactionList',
        'finance.overview',
        'finance.budgetList',
        'finance.recurringList'
    );
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
                    // Une coupure passagère ne touche à rien: la dernière valeur
                    // connue reste affichée, et la reconnexion relira. Retomber à
                    // zéro afficherait un solde faux, ce qui est bien pire que
                    // d'afficher un solde d'il y a une minute.
                });
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [workspace, version]);

    return { summary, loading };
}
