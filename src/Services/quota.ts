import { ACCOUNT_PLAN_PROVIDER, type AccountPlan, type AccountPlanProvider } from '@deveye/types/sdk';
import type { SdkProviders } from '@deveye/types/sdk/server';

import type { Database } from '@/db';

interface QuotaLogger {
    error(obj: object, msg: string): void;
}

/**
 * L'offre d'un compte, dite par le module qui en tient une. `null` = aucun
 * fournisseur installé, donc aucune limite : c'est une installation
 * auto-hébergée. Un fournisseur en panne vaut pareil, pour qu'une défaillance
 * de la facturation ne bloque jamais une création.
 */
export async function planOf(
    providers: SdkProviders,
    userId: number,
    logger: QuotaLogger
): Promise<AccountPlan | null> {
    const provider = providers.get<AccountPlanProvider>(ACCOUNT_PLAN_PROVIDER);
    if (!provider) return null;
    try {
        return await provider.planFor(userId);
    } catch (e) {
        logger.error({ err: (e as Error).message, userId }, 'Offre du compte illisible, aucune limite appliquée');
        return null;
    }
}

/** La limite d'une clé `<featureId>.<quotaKey>` pour ce compte, `null` = illimité. */
export function limitIn(plan: AccountPlan | null, fullKey: string): number | null {
    return plan?.limits[fullKey] ?? null;
}

/** Les espaces que possède un compte : ce contre quoi ses quotas se comptent. */
export function ownedWorkspaceIds(db: Pick<Database, 'workspaces'>, userId: number): Promise<number[]> {
    return db.workspaces.listOwnedIds(userId);
}
