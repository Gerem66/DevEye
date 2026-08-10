import { devicePower, type AgentPowerAction } from 'deveye-types';

import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { authorizeReachableDevice } from './shared';

/** French label per power action, for the audit description. */
const POWER_LABELS: Record<AgentPowerAction, string> = {
    shutdown: 'Extinction',
    reboot: 'Redémarrage',
    suspend: 'Mise en veille',
    hibernate: 'Veille prolongée',
    lock: 'Verrouillage'
};

/**
 * Run a system power action on a device (shutdown / reboot / suspend / hibernate
 * / lock). Owner-or-admin + agent online. The command only pushes the order; the
 * agent applies it best-effort and the outcome streams back as a
 * `device.powerResult` push event (the caller must be subscribed to the device).
 */
export const devicePowerFeature: FeatureDefinition<
    typeof devicePower.command,
    typeof devicePower.input,
    typeof devicePower.output
> = defineFeature({
    ...devicePower,
    access: { feature: 'devices', level: 'write' },
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestPower(row.id, { action: input.action }) ?? false;
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        ctx.audit({
            action: 'device.power',
            level: 'warning',
            description: `Commande système « ${POWER_LABELS[input.action]} » demandée : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id, powerAction: input.action }
        });
        return { ok: true };
    }
});
