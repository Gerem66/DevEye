import type { AccountPlan } from '@deveye/types/sdk';

import { useResource } from '@/api/useResource';
import { ws } from '@/api/ws';
import { useMaintenance } from './maintenance';

/**
 * L'offre du compte, tenue à jour en direct. `null` pendant le chargement ET
 * quand ce DevEye n'a aucun fournisseur d'offre (tout est illimité) : ne jamais
 * le lire comme « offre gratuite ».
 */
export function useAccountPlan(): AccountPlan | null {
    const { data } = useResource('user.plan', () => ws.send('user.plan', {}), 'Offre illisible.');
    return data?.plan ?? null;
}

const NONE: Readonly<Record<string, number>> = {};

/** Ce que l'offre du compte tient en pause, par clé complète. Vide pendant le chargement. */
export function usePlanPauses(): Readonly<Record<string, number>> {
    const { data } = useResource('user.plan', () => ws.send('user.plan', {}), 'Offre illisible.');
    return data?.paused ?? NONE;
}

/**
 * La priorité aux abonnés tient ce compte : tout ce qui tourne pour lui est en
 * pause et il ne crée plus rien. Faux sans fournisseur d'offre.
 */
export function usePriorityHold(): boolean {
    const plan = useAccountPlan();
    return useMaintenance().priority && plan !== null && !plan.priority;
}
