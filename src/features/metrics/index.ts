import { metricsQuery, metricsSubscribe, metricsUnsubscribe, type DeviceRow } from 'deveye-types';

import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';

async function isAdmin(ctx: FeatureContext): Promise<boolean> {
    const user = await ctx.db.users.findById(ctx.userId);
    return user?.role === 'admin';
}

/** Ensure the caller may read a device's metrics (owner or admin). */
async function authorizeRead(ctx: FeatureContext, deviceId: string): Promise<DeviceRow> {
    const row = await ctx.db.devices.findById(deviceId);
    if (!row) throw new FeatureError('not_found', 'Device not found');
    if (row.owner_id !== ctx.userId && !(await isAdmin(ctx))) {
        throw new FeatureError('forbidden', 'Not allowed to read this device');
    }
    return row;
}

export const metricsQueryFeature: FeatureDefinition<
    typeof metricsQuery.command,
    typeof metricsQuery.input,
    typeof metricsQuery.output
> = defineFeature({
    ...metricsQuery,
    handler: async (ctx, input) => {
        await authorizeRead(ctx, input.deviceId);
        const points = await ctx.db.metrics.query({
            deviceId: input.deviceId,
            from: input.from,
            to: input.to,
            resolution: input.resolution
        });
        return { deviceId: input.deviceId, points };
    }
});

export const metricsSubscribeFeature: FeatureDefinition<
    typeof metricsSubscribe.command,
    typeof metricsSubscribe.input,
    typeof metricsSubscribe.output
> = defineFeature({
    ...metricsSubscribe,
    handler: async (ctx, input) => {
        const allowed: string[] = [];
        for (const deviceId of input.deviceIds) {
            await authorizeRead(ctx, deviceId);
            allowed.push(deviceId);
        }
        ctx.monitor?.subscribe(allowed);
        return { deviceIds: allowed };
    }
});

export const metricsUnsubscribeFeature: FeatureDefinition<
    typeof metricsUnsubscribe.command,
    typeof metricsUnsubscribe.input,
    typeof metricsUnsubscribe.output
> = defineFeature({
    ...metricsUnsubscribe,
    handler: async (ctx, input) => {
        ctx.monitor?.unsubscribe(input.deviceIds);
        return { deviceIds: input.deviceIds };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const metricsFeatures: FeatureDefinition<string, any, any>[] = [
    metricsQueryFeature,
    metricsSubscribeFeature,
    metricsUnsubscribeFeature
];
