import { agentLifecycle, type AgentLifecycleAction } from '@deveye/types';

import { authorizeReachableDevice } from '@/agent/authorize';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';

/** French label per lifecycle action, for the audit description. */
const LIFECYCLE_LABELS: Record<AgentLifecycleAction, string> = {
    restart: 'Redémarrage',
    pause: 'Mise en pause',
    resume: 'Reprise'
};

/**
 * Redémarrer, mettre en pause ou reprendre l'agent d'un appareil. Exige
 * `devices: write` sur l'espace et un agent en ligne, ou en pause et joignable
 * pour la reprise. Sans trame de réponse : l'issue se lit sur la présence et
 * sur le champ `pause` de l'appareil.
 */
export const agentLifecycleFeature: FeatureDefinition<
    typeof agentLifecycle.command,
    typeof agentLifecycle.input,
    typeof agentLifecycle.output
> = defineFeature({
    ...agentLifecycle,
    access: { feature: 'devices', level: 'write', item: 'deviceId' },
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId, {
            control: true,
            paused: input.action === 'resume'
        });
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
