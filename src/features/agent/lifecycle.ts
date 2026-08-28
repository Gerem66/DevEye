import { agentLifecycle, type AgentLifecycleAction } from '@deveye/types';

import { authorizeReachableDevice } from '@/agent/authorize';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';

/** French label per lifecycle action, for the audit description. */
const LIFECYCLE_LABELS: Record<AgentLifecycleAction, string> = {
    stop: 'Interruption',
    restart: 'Redémarrage'
};

/**
 * Stop or cleanly restart the agent *process* on a device. Exige `devices:
 * write` sur l'espace + un agent en ligne. Fire-and-forget: the agent exits
 * (and, supervised or on `restart`, comes back) — there is no reply frame, the
 * outcome is observed through the presence stream.
 */
export const agentLifecycleFeature: FeatureDefinition<
    typeof agentLifecycle.command,
    typeof agentLifecycle.input,
    typeof agentLifecycle.output
> = defineFeature({
    ...agentLifecycle,
    access: { feature: 'devices', level: 'write' },
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestLifecycle(row.id, { action: input.action }) ?? false;
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        ctx.audit({
            action: 'agent.lifecycle',
            level: 'warning',
            description: `${LIFECYCLE_LABELS[input.action]} de l’agent demandé(e) : « ${row.name} »`,
            metadata: { deviceId: row.id, ownerId: row.owner_id, lifecycleAction: input.action }
        });
        return { ok: true };
    }
});
