import {
    adminMaintenanceDismissNotice,
    adminMaintenanceFeature,
    adminMaintenanceGet,
    adminMaintenancePriority,
    adminMaintenanceSignups,
    adminMaintenanceSite,
    type AdminMaintenance
} from '@deveye/types';

import type { Database } from '@/db';
import { ORIGINS } from '@/features/_sdk/context';
import { moduleServiceControl } from '@/features/_sdk/register';
import { maintenance } from '@/Services/maintenance';
import { readSignups, writeSignups } from '@/Services/signup/setting';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { notifyAdmins } from './notify';

/**
 * La page Maintenance. Chaque changement est diffusé à tous les écrans par
 * `Services/maintenance.ts`, les pages des autres administrateurs comprises.
 */
const ADMIN = { admin: true, scope: 'account' } as const;

/** Les inscriptions se rangent par origine : celles de ce serveur seulement. */
async function pageState(db: Database): Promise<AdminMaintenance> {
    const [state, signups] = await Promise.all([maintenance.adminState(), readSignups(db, ORIGINS.app)]);
    return { ...state, signups: { ...signups, origin: ORIGINS.app } };
}

export const adminMaintenanceGetFeature: FeatureDefinition<
    typeof adminMaintenanceGet.command,
    typeof adminMaintenanceGet.input,
    typeof adminMaintenanceGet.output
> = defineFeature({
    ...adminMaintenanceGet,
    access: ADMIN,
    handler: async (ctx) => pageState(ctx.db)
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
        return pageState(ctx.db);
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
        return pageState(ctx.db);
    }
});

export const adminMaintenancePriorityFeature: FeatureDefinition<
    typeof adminMaintenancePriority.command,
    typeof adminMaintenancePriority.input,
    typeof adminMaintenancePriority.output
> = defineFeature({
    ...adminMaintenancePriority,
    access: ADMIN,
    handler: async (ctx, input) => {
        if (input.active && !maintenance.priorityAvailable()) {
            throw new FeatureError('validation', 'Aucun module ne tient les offres : personne n’est abonné');
        }
        const before = maintenance.priority();
        await maintenance.setPriority(input.active, ctx.userId);
        if (before !== input.active) {
            ctx.audit({
                action: input.active ? 'maintenance.priorityOn' : 'maintenance.priorityOff',
                level: 'warning',
                category: 'system',
                description: input.active ? 'Priorité aux abonnés activée' : 'Priorité aux abonnés levée'
            });
        }
        return pageState(ctx.db);
    }
});

export const adminMaintenanceSignupsFeature: FeatureDefinition<
    typeof adminMaintenanceSignups.command,
    typeof adminMaintenanceSignups.input,
    typeof adminMaintenanceSignups.output
> = defineFeature({
    ...adminMaintenanceSignups,
    access: ADMIN,
    handler: async (ctx, input) => {
        await writeSignups(ctx.db, ORIGINS.app, input.open, ctx.userId);
        ctx.audit({
            action: input.open ? 'maintenance.signupsOpen' : 'maintenance.signupsClosed',
            level: 'warning',
            category: 'system',
            description: input.open ? 'Inscriptions ouvertes' : 'Inscriptions fermées',
            metadata: { origin: ORIGINS.app }
        });
        // Le réglage ne passe pas par l'état diffusé : les pages des autres administrateurs se relisent.
        if (ctx.live) await notifyAdmins(ctx.db, ctx.live, ctx.workspaceId, ctx.userId);
        return pageState(ctx.db);
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
    adminMaintenancePriorityFeature,
    adminMaintenanceSignupsFeature,
    adminMaintenanceDismissNoticeFeature
];
