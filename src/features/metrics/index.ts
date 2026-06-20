import { metricsQuery, metricsRefresh, metricsSubscribe, metricsUnsubscribe, type DeviceRow } from 'deveye-types';

import { parseDeviceReport } from '@/agent/mappers';
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
        const allowed: { id: string; row: DeviceRow }[] = [];
        for (const deviceId of input.deviceIds) {
            const row = await authorizeRead(ctx, deviceId);
            allowed.push({ id: deviceId, row });
        }
        const ids = allowed.map((a) => a.id);
        ctx.monitor?.subscribe(ids);

        // Push the latest stored snapshot + report straight away so the UI shows
        // data immediately rather than waiting for the next live sample.
        for (const { id, row } of allowed) {
            const snapshot = await ctx.db.metrics.latest(id);
            ctx.monitor?.sendInitial(id, snapshot, parseDeviceReport(row.report_json));
        }
        return { deviceIds: ids };
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

export const metricsRefreshFeature: FeatureDefinition<
    typeof metricsRefresh.command,
    typeof metricsRefresh.input,
    typeof metricsRefresh.output
> = defineFeature({
    ...metricsRefresh,
    handler: async (ctx, input) => {
        await authorizeRead(ctx, input.deviceId);
        const requested = ctx.monitor?.requestCollect(input.deviceId) ?? false;
        return { deviceId: input.deviceId, requested };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const metricsFeatures: FeatureDefinition<string, any, any>[] = [
    metricsQueryFeature,
    metricsSubscribeFeature,
    metricsUnsubscribeFeature,
    metricsRefreshFeature
];
