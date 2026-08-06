import { deviceDropPrivileges, deviceElevate, deviceSetAutostart } from 'deveye-types';

import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { authorizeOnlineDevice, toDevice } from './shared';

/**
 * The exact command to run on the device when the agent can't pop an OS auth
 * prompt itself (no interactive session). Deterministic per platform; shown by the
 * UI as the manual fallback for `elevate`/`drop`.
 */
function manualCommand(platform: string, action: 'elevate' | 'drop'): string {
    const windows = platform === 'windows';
    if (action === 'elevate') {
        return windows
            ? 'deveye-agent service install --system   (à lancer en tant qu’administrateur)'
            : 'sudo deveye-agent service install --system';
    }
    return windows
        ? 'deveye-agent service uninstall puis deveye-agent service install --user   (administrateur)'
        : 'sudo deveye-agent service uninstall && deveye-agent service install --user';
}

export const deviceSetAutostartFeature: FeatureDefinition<
    typeof deviceSetAutostart.command,
    typeof deviceSetAutostart.input,
    typeof deviceSetAutostart.output
> = defineFeature({
    ...deviceSetAutostart,
    mutates: true,
    handler: async (ctx, input) => {
        const row = await authorizeOnlineDevice(ctx, input.deviceId);
        const pushed = ctx.monitor?.requestService(row.id, {
            action: input.enabled ? 'install-user' : 'uninstall-user'
        });
        if (!pushed) throw new FeatureError('conflict', 'Agent hors ligne');
        ctx.audit({
            action: 'device.setAutostart',
            description: `Démarrage automatique ${input.enabled ? 'activé' : 'désactivé'} : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id, enabled: input.enabled }
        });
        return { device: await toDevice(ctx, row) };
    }
});

export const deviceElevateFeature: FeatureDefinition<
    typeof deviceElevate.command,
    typeof deviceElevate.input,
    typeof deviceElevate.output
> = defineFeature({
    ...deviceElevate,
    mutates: true,
    handler: async (ctx, input) => {
        const row = await authorizeOnlineDevice(ctx, input.deviceId);
        const pushed = ctx.monitor?.requestService(row.id, { action: 'elevate' });
        if (!pushed) throw new FeatureError('conflict', 'Agent hors ligne');
        ctx.audit({
            action: 'device.elevate',
            level: 'warning',
            description: `Élévation root demandée : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id }
        });
        return { device: await toDevice(ctx, row), manualCommand: manualCommand(row.platform, 'elevate') };
    }
});

export const deviceDropPrivilegesFeature: FeatureDefinition<
    typeof deviceDropPrivileges.command,
    typeof deviceDropPrivileges.input,
    typeof deviceDropPrivileges.output
> = defineFeature({
    ...deviceDropPrivileges,
    mutates: true,
    handler: async (ctx, input) => {
        const row = await authorizeOnlineDevice(ctx, input.deviceId);
        const pushed = ctx.monitor?.requestService(row.id, { action: 'drop' });
        if (!pushed) throw new FeatureError('conflict', 'Agent hors ligne');
        ctx.audit({
            action: 'device.dropPrivileges',
            level: 'warning',
            description: `Rétrogradation des privilèges demandée : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id }
        });
        return { device: await toDevice(ctx, row), manualCommand: manualCommand(row.platform, 'drop') };
    }
});
