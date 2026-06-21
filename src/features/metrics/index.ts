import {
    metricsAvailability,
    metricsPresence,
    metricsProcessesAt,
    metricsQuery,
    metricsRefresh,
    metricsSnapshots,
    metricsSubscribe,
    metricsUnsubscribe,
    type DeviceRow
} from 'deveye-types';

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

export const metricsPresenceFeature: FeatureDefinition<
    typeof metricsPresence.command,
    typeof metricsPresence.input,
    typeof metricsPresence.output
> = defineFeature({
    ...metricsPresence,
    handler: async (ctx, input) => {
        await authorizeRead(ctx, input.deviceId);
        const [onlineAtStart, events] = await Promise.all([
            ctx.db.presence.onlineAt(input.deviceId, input.from),
            ctx.db.presence.query(input.deviceId, input.from, input.to)
        ]);
        return { deviceId: input.deviceId, onlineAtStart, events };
    }
});

export const metricsProcessesAtFeature: FeatureDefinition<
    typeof metricsProcessesAt.command,
    typeof metricsProcessesAt.input,
    typeof metricsProcessesAt.output
> = defineFeature({
    ...metricsProcessesAt,
    handler: async (ctx, input) => {
        await authorizeRead(ctx, input.deviceId);
        const sample = await ctx.db.processSamples.nearest(input.deviceId, input.at);
        return { deviceId: input.deviceId, sample };
    }
});

export const metricsAvailabilityFeature: FeatureDefinition<
    typeof metricsAvailability.command,
    typeof metricsAvailability.input,
    typeof metricsAvailability.output
> = defineFeature({
    ...metricsAvailability,
    handler: async (ctx, input) => {
        await authorizeRead(ctx, input.deviceId);
        const days = await ctx.db.metrics.availableDays(input.deviceId, input.tzOffsetMinutes);
        return { deviceId: input.deviceId, days };
    }
});

export const metricsSnapshotsFeature: FeatureDefinition<
    typeof metricsSnapshots.command,
    typeof metricsSnapshots.input,
    typeof metricsSnapshots.output
> = defineFeature({
    ...metricsSnapshots,
    handler: async (ctx, input) => {
        await authorizeRead(ctx, input.deviceId);
        const timestamps = await ctx.db.processSamples.snapshotTimes(input.deviceId, input.from, input.to);
        return { deviceId: input.deviceId, timestamps };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const metricsFeatures: FeatureDefinition<string, any, any>[] = [
    metricsQueryFeature,
    metricsSubscribeFeature,
    metricsUnsubscribeFeature,
    metricsRefreshFeature,
    metricsPresenceFeature,
    metricsProcessesAtFeature,
    metricsAvailabilityFeature,
    metricsSnapshotsFeature
];
