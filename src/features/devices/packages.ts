import { deviceListPackages, deviceUpgradePackages } from 'deveye-types';

import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { authorizeOnlineDevice } from './shared';

/**
 * Ask the agent to enumerate its package managers. The result streams back
 * asynchronously as a `package.list` push event (caller must be subscribed).
 */
export const deviceListPackagesFeature: FeatureDefinition<
    typeof deviceListPackages.command,
    typeof deviceListPackages.input,
    typeof deviceListPackages.output
> = defineFeature({
    ...deviceListPackages,
    access: { admin: true },
    handler: async (ctx, input) => {
        const row = await authorizeOnlineDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestPkgList(row.id) ?? false;
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        return { ok: true };
    }
});

/**
 * Apply a manager's updates. Progress streams back as `package.progress` then
 * `package.done` events.
 */
export const deviceUpgradePackagesFeature: FeatureDefinition<
    typeof deviceUpgradePackages.command,
    typeof deviceUpgradePackages.input,
    typeof deviceUpgradePackages.output
> = defineFeature({
    ...deviceUpgradePackages,
    access: { admin: true },
    handler: async (ctx, input) => {
        const row = await authorizeOnlineDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestPkgUpgrade(row.id, { manager: input.manager }) ?? false;
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        ctx.audit({
            action: 'device.upgradePackages',
            level: 'warning',
            description: `Mise à jour « ${input.manager} » lancée : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id, manager: input.manager }
        });
        return { ok: true };
    }
});
