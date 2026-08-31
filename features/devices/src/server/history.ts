import { defineSdkFeature } from '@deveye/types/sdk/server';

import {
    devicesAvailability,
    devicesDeleteSnapshots,
    devicesMetrics,
    devicesPresence,
    devicesProcessesAt,
    devicesSetSnapshotsPinned,
    devicesSnapshots,
    devicesStorage
} from '../contracts/commands';
import { env } from './env';
import type { DevicesRepo } from './repo';
import { assertDevice, loadDevice, WRITE } from './_shared';

/**
 * L'historique d'un appareil, lu et entretenu en base : métriques, présence,
 * processus, instants épinglés. Chaque commande ouvre sur `assertDevice` (la
 * garde unique des appareils, plus la restriction de rôle sur cette ligne) ; le
 * niveau exigé est déclaré dans `access` (`write` pour ce qui efface ou épingle).
 */

export const devicesMetricsFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesMetrics.command,
    typeof devicesMetrics.input,
    typeof devicesMetrics.output
>({
    ...devicesMetrics,
    handler: async (ctx, input) => {
        await assertDevice(ctx, input.deviceId);
        const points = await ctx.repo.metrics.query({
            deviceId: input.deviceId,
            from: input.from,
            to: input.to,
            resolution: input.resolution
        });
        return { deviceId: input.deviceId, points };
    }
});

export const devicesPresenceFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesPresence.command,
    typeof devicesPresence.input,
    typeof devicesPresence.output
>({
    ...devicesPresence,
    handler: async (ctx, input) => {
        await assertDevice(ctx, input.deviceId);
        const [onlineAtStart, events] = await Promise.all([
            ctx.repo.presence.onlineAt(input.deviceId, input.from),
            ctx.repo.presence.query(input.deviceId, input.from, input.to)
        ]);
        return { deviceId: input.deviceId, onlineAtStart, events };
    }
});

export const devicesProcessesAtFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesProcessesAt.command,
    typeof devicesProcessesAt.input,
    typeof devicesProcessesAt.output
>({
    ...devicesProcessesAt,
    handler: async (ctx, input) => {
        await assertDevice(ctx, input.deviceId);
        const sample = await ctx.repo.processSamples.nearest(input.deviceId, input.at);
        return { deviceId: input.deviceId, sample };
    }
});

export const devicesAvailabilityFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesAvailability.command,
    typeof devicesAvailability.input,
    typeof devicesAvailability.output
>({
    ...devicesAvailability,
    handler: async (ctx, input) => {
        await assertDevice(ctx, input.deviceId);
        const days = await ctx.repo.metrics.availableDays(input.deviceId, input.tzOffsetMinutes);
        return { deviceId: input.deviceId, days };
    }
});

export const devicesSnapshotsFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesSnapshots.command,
    typeof devicesSnapshots.input,
    typeof devicesSnapshots.output
>({
    ...devicesSnapshots,
    handler: async (ctx, input) => {
        await assertDevice(ctx, input.deviceId);
        // The marks are the metric instants: process capture is optional, and a
        // `processCapture: 'off'` device still has instants to navigate. The
        // process samples only qualify which instants carry a list.
        const [instants, samples] = await Promise.all([
            ctx.repo.metrics.instantTimes(input.deviceId, input.from, input.to),
            ctx.repo.processSamples.snapshotTimes(input.deviceId, input.from, input.to)
        ]);
        // Les épingles sont posées sur les deux tables en une seule instruction :
        // les instants métriques font foi.
        return {
            deviceId: input.deviceId,
            timestamps: instants.timestamps,
            pinned: instants.pinned,
            withProcesses: samples.timestamps,
            truncated: instants.truncated
        };
    }
});

export const devicesStorageFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesStorage.command,
    typeof devicesStorage.input,
    typeof devicesStorage.output
>({
    ...devicesStorage,
    handler: async (ctx, input) => {
        await assertDevice(ctx, input.deviceId);
        const usage = await ctx.repo.processSamples.storage(input.deviceId);
        return { deviceId: input.deviceId, ...usage };
    }
});

export const devicesDeleteSnapshotsFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesDeleteSnapshots.command,
    typeof devicesDeleteSnapshots.input,
    typeof devicesDeleteSnapshots.output
>({
    ...devicesDeleteSnapshots,
    mutates: true,
    // Effacer l'historique d'une machine n'est pas de la lecture.
    access: WRITE,
    handler: async (ctx, input) => {
        const device = await loadDevice(ctx, input.deviceId, 'write');
        const { snapshots } = await ctx.repo.processSamples.deleteRange(input.deviceId, input.from, input.to);
        if (snapshots > 0) {
            const single = input.from === input.to;
            ctx.audit({
                action: 'devices.deleteSnapshots',
                level: 'warning',
                description: single
                    ? `Snapshot supprimé : « ${device.name} »`
                    : `${snapshots} snapshots supprimés : « ${device.name} »`,
                metadata: { deviceId: device.id, from: input.from, to: input.to, snapshots }
            });
        }
        return { deviceId: input.deviceId, deletedSnapshots: snapshots };
    }
});

export const devicesSetSnapshotsPinnedFeature = defineSdkFeature<
    DevicesRepo,
    typeof devicesSetSnapshotsPinned.command,
    typeof devicesSetSnapshotsPinned.input,
    typeof devicesSetSnapshotsPinned.output
>({
    ...devicesSetSnapshotsPinned,
    mutates: true,
    // Désépingler peut supprimer sur-le-champ : même niveau que la suppression.
    access: WRITE,
    handler: async (ctx, input) => {
        const device = await loadDevice(ctx, input.deviceId, 'write');
        const { deviceId, from, to, pinned } = input;

        // Pin/unpin the whole instant (process list + metric point). Le compte
        // porte sur les instants métriques : une machine en `processCapture:
        // 'off'` n'a aucune liste de processus, et compter dessus rendait zéro.
        const snapshots = await ctx.repo.metrics.setInstantsPinned(deviceId, from, to, pinned);

        // On unpin, drop the rows already past their deadline right now; the
        // rest expire at the next sweep.
        let deletedSnapshots = 0;
        if (!pinned) {
            const [proc] = await Promise.all([
                ctx.repo.processSamples.deleteExpiredInRange(deviceId, from, to, env.MONITORING_RETENTION_DAYS),
                ctx.repo.metrics.deleteExpiredInRange(deviceId, from, to, env.MONITORING_RETENTION_DAYS)
            ]);
            deletedSnapshots = proc.snapshots;
        }

        if (snapshots > 0) {
            ctx.audit({
                action: 'devices.setSnapshotsPinned',
                description: pinned
                    ? `${snapshots} snapshot(s) épinglé(s) : « ${device.name} »`
                    : `${snapshots} snapshot(s) désépinglé(s) : « ${device.name} »`,
                metadata: { deviceId, from, to, pinned, snapshots, deletedSnapshots }
            });
        }

        return { deviceId, affected: snapshots, deletedSnapshots };
    }
});
