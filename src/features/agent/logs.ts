import { agentLogQuery, agentLogSources } from '@deveye/types';

import { authorizeReachableDevice } from '@/agent/authorize';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';

/**
 * Ask the agent to enumerate its log sources (system journal, Docker containers,
 * log files…). Needs the `logs` permission on Appareils + agent online. The list
 * streams back as a
 * `device.logSources` push event (caller must be subscribed to the device).
 */
export const agentLogSourcesFeature: FeatureDefinition<
    typeof agentLogSources.command,
    typeof agentLogSources.input,
    typeof agentLogSources.output
> = defineFeature({
    ...agentLogSources,
    access: { feature: 'devices', extras: ['logs'], item: 'deviceId' },
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestLogSources(row.id) ?? false;
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        return { ok: true };
    }
});

/**
 * Run one log query on a source with an advanced filter. Lines stream back as
 * `device.logLines` push events keyed by `queryId`, to the socket that asked.
 * Read-only; the agent reads the logs live (nothing is persisted server-side).
 * Only the first page of a query is audited: the next ones are the same read.
 */
export const agentLogQueryFeature: FeatureDefinition<
    typeof agentLogQuery.command,
    typeof agentLogQuery.input,
    typeof agentLogQuery.output
> = defineFeature({
    ...agentLogQuery,
    access: { feature: 'devices', extras: ['logs'], item: 'deviceId' },
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId, { control: true });
        const ok =
            ctx.monitor?.requestLogQuery(row.id, {
                queryId: input.queryId,
                sourceId: input.sourceId,
                filter: input.filter,
                limit: input.limit,
                offset: input.offset,
                anchor: input.anchor
            }) ?? false;
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        if (!input.offset && !input.anchor) {
            ctx.audit({
                action: 'agent.logQuery',
                description: `Lecture de journal sur « ${row.name} » : ${input.sourceId}`,
                metadata: { deviceId: row.id, ownerId: row.owner_id, sourceId: input.sourceId }
            });
        }
        return { ok: true };
    }
});
