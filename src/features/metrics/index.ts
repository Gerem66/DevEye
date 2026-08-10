import {
    metricsAvailability,
    metricsDeleteSnapshots,
    metricsPresence,
    metricsProcessesAt,
    metricsQuery,
    metricsRefresh,
    metricsSetSnapshotsPinned,
    metricsSnapshots,
    metricsStorage,
    metricsSubscribe,
    metricsUnsubscribe,
    type DeviceRow
} from 'deveye-types';

import { parseDeviceReport } from '@/agent/mappers';
import { env } from '@/Utils/Env';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';

/** Ensure the caller may read a device's metrics: same workspace, or admin. */
async function authorizeRead(ctx: FeatureContext, deviceId: string): Promise<DeviceRow> {
    const row = await ctx.db.devices.findById(deviceId);
    if (!row) throw new FeatureError('not_found', 'Device not found');
    if (row.workspace_id !== ctx.workspaceId && !ctx.isAdmin) {
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

        // Push the latest stored instant + report straight away so the UI shows
        // data immediately rather than waiting for the next live sample. The
        // instant's process list is seeded too: it now travels with the metric
        // stream, so without it the process table would stay empty for a whole
        // collection cadence.
        for (const { id, row } of allowed) {
            const point = await ctx.db.metrics.latest(id);
            const sample = point ? await ctx.db.processSamples.nearest(id, point.timestamp) : null;
            ctx.monitor?.sendInitial(id, point, sample, parseDeviceReport(row.report_json));
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
        // The marks are the *metric* instants: process capture is optional, and
        // keying them on the process blob left a `processCapture: 'off'` device
        // with an empty timeline — no marks, and the ‹ › / arrow-key stepping
        // permanently disabled. The process samples only qualify which instants
        // carry a list, and still supply the pinned set they pin in lockstep.
        const [instants, samples] = await Promise.all([
            ctx.db.metrics.instantTimes(input.deviceId, input.from, input.to),
            ctx.db.processSamples.snapshotTimes(input.deviceId, input.from, input.to)
        ]);
        // Pins are applied to both tables together (`metrics.setSnapshotsPinned`),
        // so either side is authoritative; union them so a row that only got one
        // half of a past pin still reads as pinned.
        const pinned = [...new Set([...instants.pinned, ...samples.pinned])].sort((a, b) => a - b);
        return {
            deviceId: input.deviceId,
            timestamps: instants.timestamps,
            pinned,
            withProcesses: samples.timestamps,
            truncated: false
        };
    }
});

export const metricsStorageFeature: FeatureDefinition<
    typeof metricsStorage.command,
    typeof metricsStorage.input,
    typeof metricsStorage.output
> = defineFeature({
    ...metricsStorage,
    handler: async (ctx, input) => {
        await authorizeRead(ctx, input.deviceId);
        const usage = await ctx.db.processSamples.storage(input.deviceId);
        return { deviceId: input.deviceId, ...usage };
    }
});

export const metricsDeleteSnapshotsFeature: FeatureDefinition<
    typeof metricsDeleteSnapshots.command,
    typeof metricsDeleteSnapshots.input,
    typeof metricsDeleteSnapshots.output
> = defineFeature({
    ...metricsDeleteSnapshots,
    mutates: true,
    handler: async (ctx, input) => {
        const row = await authorizeRead(ctx, input.deviceId);
        const { snapshots } = await ctx.db.processSamples.deleteRange(input.deviceId, input.from, input.to);
        if (snapshots > 0) {
            const single = input.from === input.to;
            ctx.audit({
                action: 'metrics.deleteSnapshots',
                level: 'warning',
                description: single
                    ? `Snapshot supprimé : « ${row.name} »`
                    : `${snapshots} snapshots supprimés : « ${row.name} »`,
                metadata: { deviceId: row.id, from: input.from, to: input.to, snapshots }
            });
        }
        return { deviceId: input.deviceId, deletedSnapshots: snapshots };
    }
});

export const metricsSetSnapshotsPinnedFeature: FeatureDefinition<
    typeof metricsSetSnapshotsPinned.command,
    typeof metricsSetSnapshotsPinned.input,
    typeof metricsSetSnapshotsPinned.output
> = defineFeature({
    ...metricsSetSnapshotsPinned,
    mutates: true,
    handler: async (ctx, input) => {
        const row = await authorizeRead(ctx, input.deviceId);
        const { deviceId, from, to, pinned } = input;

        // Pin/unpin the whole instant (process list + metric point) so a saved
        // moment stays fully consultable past the device's retention.
        const [{ snapshots }] = await Promise.all([
            ctx.db.processSamples.setPinnedRange(deviceId, from, to, pinned),
            ctx.db.metrics.setPinnedRange(deviceId, from, to, pinned)
        ]);

        // On unpin, the rows revert to normal retention: drop those already past
        // their deadline right now; the rest expire at the next hourly sweep.
        let deletedSnapshots = 0;
        if (!pinned) {
            const [proc] = await Promise.all([
                ctx.db.processSamples.deleteExpiredInRange(deviceId, from, to, env.MONITORING_RETENTION_DAYS),
                ctx.db.metrics.deleteExpiredInRange(deviceId, from, to, env.MONITORING_RETENTION_DAYS)
            ]);
            deletedSnapshots = proc.snapshots;
        }

        if (snapshots > 0) {
            ctx.audit({
                action: 'metrics.setSnapshotsPinned',
                description: pinned
                    ? `${snapshots} snapshot(s) épinglé(s) : « ${row.name} »`
                    : `${snapshots} snapshot(s) désépinglé(s) : « ${row.name} »`,
                metadata: { deviceId, from, to, pinned, snapshots, deletedSnapshots }
            });
        }

        return { deviceId, affected: snapshots, deletedSnapshots };
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
    metricsSnapshotsFeature,
    metricsStorageFeature,
    metricsDeleteSnapshotsFeature,
    metricsSetSnapshotsPinnedFeature
];
