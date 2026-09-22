import { useEffect, useState } from 'react';
import { featureApi, invalidate, onSocketOpen, useActiveWorkspace, useResourceVersion } from 'deveye-sdk-client';
import type { InvoicingSummary } from '../contracts/domain';

import { manifest } from '../manifest';

/** L'envoi typé des commandes du module, partagé par toutes ses vues. */
export const api = featureApi(manifest);

/**
 * Le résumé de la carte de l'accueil. Pas `useWorkspaceCount` : il n'accepte
 * que les commandes rendant `{ count }`, et ce qui compte ici est un montant.
 */
export function useInvoicingSummary(): { summary: InvoicingSummary | null; loading: boolean } {
    const workspace = useActiveWorkspace();
    const version = useResourceVersion('invoicing.count');
    const [summary, setSummary] = useState<InvoicingSummary | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!workspace) return;
        let cancelled = false;

        // Chargé à l'ouverture de la socket (tout de suite si elle l'est déjà),
        // et rechargé à chaque reconnexion : la primitive du SDK fait les deux.
        const off = onSocketOpen(() => {
            api.send('invoicing.count', {})
                .then((res) => {
                    if (cancelled) return;
                    setSummary(res.summary);
                    setLoading(false);
                })
                .catch(() => {
                    // Une coupure passagère ne touche à rien : la dernière
                    // valeur reste, la reconnexion relira. Un zéro laisserait
                    // croire qu'il n'y a plus rien à encaisser.
                });
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [workspace, version]);

    return { summary, loading };
}

/** Ce que remue une écriture sur un document émis : tout sauf les réglages. */
export function refreshInvoicing(): void {
    invalidate('invoicing.count', 'invoicing.dashboard', 'invoicing.docList', 'invoicing.doc');
}
