import { userPlan } from '@deveye/types';

import { planOf } from '@/Services/quota';
import { defineFeature, type FeatureDefinition } from '../_define';
import { moduleProvider } from '../_sdk/register';

/** L'offre de l'appelant. `null` sans module de facturation : tout est illimité. */
export const userPlanFeature: FeatureDefinition<
    typeof userPlan.command,
    typeof userPlan.input,
    typeof userPlan.output
> = defineFeature({
    ...userPlan,
    access: { scope: 'account' },
    handler: async (ctx) => ({
        plan: await planOf({ get: <T>(key: string) => moduleProvider<T>(key) }, ctx.userId, ctx.logger)
    })
});
