import { deviceListPackages, deviceUpgradePackages } from '@deveye/types';

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
        const monitor = ctx.monitor;
        if (!monitor) throw new FeatureError('conflict', 'Agent hors ligne');
        // Le verrou d'abord : c'est la seule barrière qui tienne quels que soient
        // l'écran, l'onglet ou la personne à l'origine du second clic. Il est
        // relâché par `pkg.done`, ou d'autorité si l'agent s'en va.
        if (!monitor.beginUpgrade(row.id, input.manager)) {
            throw new FeatureError('conflict', `Une mise à jour « ${input.manager} » est déjà en cours`);
        }
        if (!monitor.requestPkgUpgrade(row.id, { manager: input.manager })) {
            monitor.endUpgrade(row.id, input.manager);
            throw new FeatureError('conflict', 'Agent hors ligne');
        }
        // Annoncé sans attendre la première ligne de l'outil : les autres écrans
        // doivent griser le bouton dès maintenant.
        monitor.publishPackageStarted({ deviceId: row.id, manager: input.manager });
        ctx.audit({
            action: 'device.upgradePackages',
            level: 'warning',
            description: `Mise à jour « ${input.manager} » lancée : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id, manager: input.manager }
        });
        return { ok: true };
    }
});
