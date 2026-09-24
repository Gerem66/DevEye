import type { FeatureContext } from './_define';
import { moduleProvider } from './_sdk/register';
import { assertPlanLimit, limitIn, ownedWorkspaceIds, planOf, type PlanLimitCheck } from '@/Services/quota';

const providers = { get: <T>(key: string) => moduleProvider<T>(key) };

/**
 * Ce que le cœur borne lui-même, sans manifest : les espaces partagés d'un
 * compte, leurs membres et leurs domaines web. Mêmes règles que les quotas des
 * modules, et même absence de limite sans module d'offre installé.
 */
export function assertCoreLimit(ctx: FeatureContext, check: PlanLimitCheck): Promise<void> {
    return assertPlanLimit(ctx.db, providers, ctx.logger, check);
}

/**
 * Ce qu'un écran annonce avant le refus : la limite d'une clé du cœur pour ce
 * compte, et les espaces sur lesquels elle se compte. `null` : illimitée.
 */
export async function coreAllowance(
    ctx: FeatureContext,
    ownerUserId: number,
    fullKey: string
): Promise<{ limit: number; ownerWorkspaceIds: number[] } | null> {
    const limit = limitIn(await planOf(providers, ownerUserId, ctx.logger), fullKey);
    if (limit === null) return null;
    return { limit, ownerWorkspaceIds: await ownedWorkspaceIds(ctx.db, ownerUserId) };
}
