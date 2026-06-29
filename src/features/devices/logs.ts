import { deviceLogQuery, deviceLogSources } from 'deveye-types';

import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';
import { authorizeReachableDevice } from './shared';

/**
 * Ask the agent to enumerate its log sources (system journal, Docker containers,
 * log files…). Owner-or-admin + agent online. The list streams back as a
 * `device.logSources` push event (caller must be subscribed to the device).
 */
export const deviceLogSourcesFeature: FeatureDefinition<
    typeof deviceLogSources.command,
    typeof deviceLogSources.input,
    typeof deviceLogSources.output
> = defineFeature({
    ...deviceLogSources,
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok = ctx.monitor?.requestLogSources(row.id) ?? false;
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        return { ok: true };
    }
});

/**
 * Run one log query on a source with an advanced filter. Lines stream back as
 * `device.logLines` push events keyed by `queryId`. Read-only; the agent reads the
 * logs live (nothing is persisted server-side).
 */
export const deviceLogQueryFeature: FeatureDefinition<
    typeof deviceLogQuery.command,
    typeof deviceLogQuery.input,
    typeof deviceLogQuery.output
> = defineFeature({
    ...deviceLogQuery,
    handler: async (ctx, input) => {
        const row = await authorizeReachableDevice(ctx, input.deviceId);
        const ok =
            ctx.monitor?.requestLogQuery(row.id, {
                queryId: input.queryId,
                sourceId: input.sourceId,
                filter: input.filter,
                limit: input.limit
            }) ?? false;
        if (!ok) throw new FeatureError('conflict', 'Agent hors ligne');
        return { ok: true };
    }
});
