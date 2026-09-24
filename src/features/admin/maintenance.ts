import {
    adminMaintenanceDismissNotice,
    adminMaintenanceFeature,
    adminMaintenanceGet,
    adminMaintenanceSite
} from '@deveye/types';

import { moduleServiceControl } from '@/features/_sdk/register';
import { maintenance } from '@/Services/maintenance';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';

/**
 * La page Maintenance. Chaque changement est diffusé à tous les écrans par
 * `Services/maintenance.ts`, les pages des autres administrateurs comprises.
 */
const ADMIN = { admin: true, scope: 'account' } as const;

export const adminMaintenanceGetFeature: FeatureDefinition<
    typeof adminMaintenanceGet.command,
    typeof adminMaintenanceGet.input,
    typeof adminMaintenanceGet.output
> = defineFeature({
    ...adminMaintenanceGet,
    access: ADMIN,
    handler: async () => maintenance.adminState()
});

export const adminMaintenanceSiteFeature: FeatureDefinition<
    typeof adminMaintenanceSite.command,
    typeof adminMaintenanceSite.input,
    typeof adminMaintenanceSite.output
> = defineFeature({
    ...adminMaintenanceSite,
    access: ADMIN,
    handler: async (ctx, input) => {
        const before = maintenance.siteDown();
        await maintenance.setSite(input.active, input.message, ctx.userId);
        if (before !== input.active) {
            ctx.audit({
                action: input.active ? 'maintenance.siteOn' : 'maintenance.siteOff',
                level: 'warning',
                category: 'system',
                description: input.active ? 'Site mis en maintenance' : 'Maintenance du site levée'
            });
        }
        return maintenance.adminState();
    }
});

const LEVEL_AUDIT = {
    open: 'rouverte',
    requests: 'mise en maintenance',
    preview: 'réservée aux administrateurs (préversion)',
    full: 'arrêtée'
} as const;

export const adminMaintenanceFeatureFeature: FeatureDefinition<
    typeof adminMaintenanceFeature.command,
    typeof adminMaintenanceFeature.input,
    typeof adminMaintenanceFeature.output
> = defineFeature({
    ...adminMaintenanceFeature,
    access: ADMIN,
    handler: async (ctx, input) => {
        if (!moduleServiceControl.installed().includes(input.feature)) {
            throw new FeatureError('not_found', `Aucune fonctionnalité « ${input.feature} » sur ce serveur`);
        }
        if (input.level === 'full' && !moduleServiceControl.hasService(input.feature)) {
            throw new FeatureError('validation', 'Cette fonctionnalité n’a aucun travail de fond à arrêter');
        }
        await maintenance.setFeature(input.feature, input.level, ctx.userId);
        ctx.audit({
            action: 'maintenance.feature',
            level: 'warning',
            category: 'system',
            description: `Fonctionnalité « ${input.feature} » ${LEVEL_AUDIT[input.level ?? 'open']}`,
            metadata: { feature: input.feature, level: input.level }
        });
        return maintenance.adminState();
    }
});

export const adminMaintenanceDismissNoticeFeature: FeatureDefinition<
    typeof adminMaintenanceDismissNotice.command,
    typeof adminMaintenanceDismissNotice.input,
    typeof adminMaintenanceDismissNotice.output
> = defineFeature({
    ...adminMaintenanceDismissNotice,
    access: ADMIN,
    handler: async () => {
        await maintenance.dismissEnvNotice();
        return {};
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const adminMaintenanceFeatures: FeatureDefinition<string, any, any>[] = [
    adminMaintenanceGetFeature,
    adminMaintenanceSiteFeature,
    adminMaintenanceFeatureFeature,
    adminMaintenanceDismissNoticeFeature
];
