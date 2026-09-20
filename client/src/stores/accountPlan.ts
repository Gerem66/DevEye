import type { AccountPlan } from '@deveye/types/sdk';

import { useResource } from '@/api/useResource';
import { ws } from '@/api/ws';

/**
 * L'offre du compte, tenue à jour en direct. `null` pendant le chargement ET
 * quand ce DevEye n'a aucun fournisseur d'offre (tout est illimité) : ne jamais
 * le lire comme « offre gratuite ».
 */
export function useAccountPlan(): AccountPlan | null {
    const { data } = useResource('user.plan', () => ws.send('user.plan', {}), 'Offre illisible.');
    return data?.plan ?? null;
}
