import { agentDropPrivileges, agentElevate, agentSetAutostart } from '@deveye/types';

import { authorizeReachableDevice, toDevice } from '@/agent/authorize';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';

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

export const agentSetAutostartFeature: FeatureDefinition<
    typeof agentSetAutostart.command,
    typeof agentSetAutostart.input,
    typeof agentSetAutostart.output
> = defineFeature({
    ...agentSetAutostart,
    access: { feature: 'devices', level: 'write', admin: true },
    mutates: true,
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const pushed = ctx.monitor?.requestService(row.id, {
            action: input.enabled ? 'install-user' : 'uninstall-user'
        });
        if (!pushed) throw new FeatureError('conflict', 'Agent hors ligne');
        ctx.audit({
            action: 'agent.setAutostart',
            description: `Démarrage automatique ${input.enabled ? 'activé' : 'désactivé'} : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id, enabled: input.enabled }
        });
        return { device: await toDevice(ctx, row) };
    }
});

export const agentElevateFeature: FeatureDefinition<
    typeof agentElevate.command,
    typeof agentElevate.input,
    typeof agentElevate.output
> = defineFeature({
    ...agentElevate,
    access: { feature: 'devices', level: 'write', admin: true },
    mutates: true,
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const pushed = ctx.monitor?.requestService(row.id, { action: 'elevate' });
        if (!pushed) throw new FeatureError('conflict', 'Agent hors ligne');
        ctx.audit({
            action: 'agent.elevate',
            level: 'warning',
            description: `Élévation root demandée : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id }
        });
        return { device: await toDevice(ctx, row), manualCommand: manualCommand(row.platform, 'elevate') };
    }
});

export const agentDropPrivilegesFeature: FeatureDefinition<
    typeof agentDropPrivileges.command,
    typeof agentDropPrivileges.input,
    typeof agentDropPrivileges.output
> = defineFeature({
    ...agentDropPrivileges,
    access: { feature: 'devices', level: 'write', admin: true },
    mutates: true,
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const pushed = ctx.monitor?.requestService(row.id, { action: 'drop' });
        if (!pushed) throw new FeatureError('conflict', 'Agent hors ligne');
        ctx.audit({
            action: 'agent.dropPrivileges',
            level: 'warning',
            description: `Rétrogradation des privilèges demandée : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id }
        });
        return { device: await toDevice(ctx, row), manualCommand: manualCommand(row.platform, 'drop') };
    }
});
