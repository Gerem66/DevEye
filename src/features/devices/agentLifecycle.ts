import { deviceAgentLifecycle, type AgentLifecycleAction } from 'deveye-types';

import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { authorizeReachableDevice } from './shared';

/** French label per lifecycle action, for the audit description. */
const LIFECYCLE_LABELS: Record<AgentLifecycleAction, string> = {
    stop: 'Interruption',
    restart: 'Redémarrage'
};

/**
 * Stop or cleanly restart the agent *process* on a device. Owner-or-admin +
 * agent online. Fire-and-forget: the agent exits (and, supervised or on
 * `restart`, comes back) — there is no reply frame, the outcome is observed
 * through the presence stream.
 */
export const deviceAgentLifecycleFeature: FeatureDefinition<
    typeof deviceAgentLifecycle.command,
    typeof deviceAgentLifecycle.input,
    typeof deviceAgentLifecycle.output
> = defineFeature({
    ...deviceAgentLifecycle,
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestLifecycle(row.id, { action: input.action }) ?? false;
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        ctx.audit({
            action: 'device.agentLifecycle',
            level: 'warning',
            description: `${LIFECYCLE_LABELS[input.action]} de l’agent demandé(e) : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id, lifecycleAction: input.action }
        });
        return { ok: true };
    }
});
