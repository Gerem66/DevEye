import { agentDropPrivileges, agentElevate, agentSetAutostart } from '@deveye/types';

import type { DeviceRow } from '@deveye/types';

import { authorizeReachableDevice, toDevice } from '@/agent/authorize';
import { parseDeviceReport } from '@/agent/mappers';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';

/**
 * La commande à lancer sur la machine quand l'agent ne peut pas agir seul : pas
 * de session pour la fenêtre d'autorisation, ou un service système sans root.
 * Le service recréé garde le démarrage automatique du rapport le plus récent.
 */
function manualCommand(row: DeviceRow, action: 'elevate' | 'drop' | 'enable' | 'disable'): string {
    const windows = row.platform === 'windows';
    const admin = (cmd: string) => (windows ? `${cmd}   (à lancer en tant qu’administrateur)` : `sudo ${cmd}`);
    const keep = parseDeviceReport(row.report_json)?.agent?.autostart === false ? ' --no-autostart' : '';
    switch (action) {
        case 'enable':
        case 'disable':
            return admin(`deveye-agent service ${action}`);
        case 'elevate':
            return admin(`deveye-agent service install --system${keep}`);
        case 'drop':
            return windows
                ? `deveye-agent service uninstall puis deveye-agent service install --user${keep}   (administrateur)`
                : `sudo deveye-agent service uninstall && deveye-agent service install --user${keep}`;
    }
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
            action: input.enabled ? 'autostart-on' : 'autostart-off'
        });
        if (!pushed) throw new FeatureError('conflict', 'Agent hors ligne');
        ctx.audit({
            action: 'agent.setAutostart',
            description: `Démarrage automatique ${input.enabled ? 'activé' : 'désactivé'} : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id, enabled: input.enabled }
        });
        return {
            device: await toDevice(ctx, row),
            manualCommand: manualCommand(row, input.enabled ? 'enable' : 'disable')
        };
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
        return { device: await toDevice(ctx, row), manualCommand: manualCommand(row, 'elevate') };
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
        return { device: await toDevice(ctx, row), manualCommand: manualCommand(row, 'drop') };
    }
});
