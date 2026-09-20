import type { FeatureContext } from './_define';
import { moduleProvider } from './_sdk/register';
import { assertPlanLimit, type PlanLimitCheck } from '@/Services/quota';

/**
 * Ce que le cœur borne lui-même, sans manifest : les espaces partagés d'un
 * compte et leurs membres. Mêmes règles que les quotas des modules, et même
 * absence de limite sans module d'offre installé.
 */
export function assertCoreLimit(ctx: FeatureContext, check: PlanLimitCheck): Promise<void> {
    return assertPlanLimit(ctx.db, { get: <T>(key: string) => moduleProvider<T>(key) }, ctx.logger, check);
}
