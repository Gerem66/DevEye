import {
    debugTrackingClear,
    debugTrackingCreate,
    debugTrackingGet,
    debugTrackingSet,
    debugTrackingUse
} from '@deveye/types';

import { selfTracking } from '@/Services/debug/selfTracking';
import { defineFeature, type FeatureContext } from '../_define';
import { notifyAdmins } from '../admin/notify';
import { ADMIN } from './access';

/** Le réglage est partagé entre administrateurs : leurs pages le relisent à l'instant. */
async function changed(ctx: FeatureContext, description: string) {
    ctx.audit({ action: 'debug.tracking', level: 'info', description });
    if (ctx.live) await notifyAdmins(ctx.db, ctx.live, ctx.workspaceId, ctx.userId);
    return selfTracking.describe();
}

export const debugTrackingGetFeature = defineFeature({
    ...debugTrackingGet,
    access: ADMIN,
    handler: async () => selfTracking.describe()
});

export const debugTrackingCreateFeature = defineFeature({
    ...debugTrackingCreate,
    mutates: true,
    access: ADMIN,
    handler: async (ctx) => {
        await selfTracking.create({ id: ctx.userId, workspaceId: ctx.workspaceId });
        return changed(ctx, 'Suivi d’usage : sites Audience manquants créés et branchés');
    }
});

export const debugTrackingUseFeature = defineFeature({
    ...debugTrackingUse,
    mutates: true,
    access: ADMIN,
    handler: async (ctx, input) => {
        await selfTracking.use(ctx.userId, input.key);
        return changed(ctx, 'Suivi d’usage : branché sur un site existant');
    }
});

export const debugTrackingSetFeature = defineFeature({
    ...debugTrackingSet,
    mutates: true,
    access: ADMIN,
    handler: async (ctx, input) => {
        await selfTracking.set(ctx.userId, input);
        return changed(
            ctx,
            `Suivi d’usage ${input.enabled ? 'actif' : 'en pause'}, administrateurs ${input.excludeAdmins ? 'écartés' : 'comptés'}`
        );
    }
});

export const debugTrackingClearFeature = defineFeature({
    ...debugTrackingClear,
    mutates: true,
    access: ADMIN,
    handler: async (ctx) => {
        await selfTracking.clear();
        return changed(ctx, 'Suivi d’usage débranché');
    }
});
