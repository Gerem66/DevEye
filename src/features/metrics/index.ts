import {
    devicesAvailability,
    devicesDeleteSnapshots,
    devicesMetrics,
    devicesPresence,
    devicesProcessesAt,
    devicesSetSnapshotsPinned,
    devicesSnapshots,
    devicesStorage,
    type DeviceRow
} from '@deveye/types';

import { authorizeDevice } from '@/agent/authorize';
import { env } from '@/Utils/Env';
import { defineFeature, type FeatureContext, type FeatureDefinition } from '../_define';

/**
 * De quel appareil parle-t-on, et m'est-il accessible ?
 *
 * Délègue à `authorizeDevice`, garde unique des appareils : il n'y avait aucune
 * raison que la supervision porte sa propre copie de la règle — et le nom
 * `authorizeRead` qu'elle portait a laissé passer deux commandes destructrices
 * (`devices.deleteSnapshots`, `devices.setSnapshotsPinned`) sous une garde de
 * lecture. Le *niveau* exigé est désormais déclaré par chaque commande dans son
 * `access`, appliqué par le dispatcheur avant le handler.
 */
async function device(ctx: FeatureContext, deviceId: string): Promise<DeviceRow> {
    return authorizeDevice(ctx, deviceId);
}

export const devicesMetricsFeature: FeatureDefinition<
    typeof devicesMetrics.command,
    typeof devicesMetrics.input,
    typeof devicesMetrics.output
> = defineFeature({
    ...devicesMetrics,
    access: { feature: 'devices', level: 'read' },
    handler: async (ctx, input) => {
        await device(ctx, input.deviceId);
        const points = await ctx.db.metrics.query({
            deviceId: input.deviceId,
            from: input.from,
            to: input.to,
            resolution: input.resolution
        });
        return { deviceId: input.deviceId, points };
    }
});

export const devicesPresenceFeature: FeatureDefinition<
    typeof devicesPresence.command,
    typeof devicesPresence.input,
    typeof devicesPresence.output
> = defineFeature({
    ...devicesPresence,
    access: { feature: 'devices', level: 'read' },
    handler: async (ctx, input) => {
        await device(ctx, input.deviceId);
        const [onlineAtStart, events] = await Promise.all([
            ctx.db.presence.onlineAt(input.deviceId, input.from),
            ctx.db.presence.query(input.deviceId, input.from, input.to)
        ]);
        return { deviceId: input.deviceId, onlineAtStart, events };
    }
});

export const devicesProcessesAtFeature: FeatureDefinition<
    typeof devicesProcessesAt.command,
    typeof devicesProcessesAt.input,
    typeof devicesProcessesAt.output
> = defineFeature({
    ...devicesProcessesAt,
    access: { feature: 'devices', level: 'read' },
    handler: async (ctx, input) => {
        await device(ctx, input.deviceId);
        const sample = await ctx.db.processSamples.nearest(input.deviceId, input.at);
        return { deviceId: input.deviceId, sample };
    }
});

export const devicesAvailabilityFeature: FeatureDefinition<
    typeof devicesAvailability.command,
    typeof devicesAvailability.input,
    typeof devicesAvailability.output
> = defineFeature({
    ...devicesAvailability,
    access: { feature: 'devices', level: 'read' },
    handler: async (ctx, input) => {
        await device(ctx, input.deviceId);
        const days = await ctx.db.metrics.availableDays(input.deviceId, input.tzOffsetMinutes);
        return { deviceId: input.deviceId, days };
    }
});

export const devicesSnapshotsFeature: FeatureDefinition<
    typeof devicesSnapshots.command,
    typeof devicesSnapshots.input,
    typeof devicesSnapshots.output
> = defineFeature({
    ...devicesSnapshots,
    access: { feature: 'devices', level: 'read' },
    handler: async (ctx, input) => {
        await device(ctx, input.deviceId);
        // The marks are the *metric* instants: process capture is optional, and
        // keying them on the process blob left a `processCapture: 'off'` device
        // with an empty timeline — no marks, and the ‹ › / arrow-key stepping
        // permanently disabled. The process samples only qualify which instants
        // carry a list, and still supply the pinned set they pin in lockstep.
        const [instants, samples] = await Promise.all([
            ctx.db.metrics.instantTimes(input.deviceId, input.from, input.to),
            ctx.db.processSamples.snapshotTimes(input.deviceId, input.from, input.to)
        ]);
        // Les épingles sont posées sur les deux tables dans une seule
        // transaction (`devices.setSnapshotsPinned`) : les instants métriques
        // font foi, et il n'y a plus de moitié d'épingle à rattraper.
        return {
            deviceId: input.deviceId,
            timestamps: instants.timestamps,
            pinned: instants.pinned,
            withProcesses: samples.timestamps,
            truncated: instants.truncated
        };
    }
});

export const devicesStorageFeature: FeatureDefinition<
    typeof devicesStorage.command,
    typeof devicesStorage.input,
    typeof devicesStorage.output
> = defineFeature({
    ...devicesStorage,
    access: { feature: 'devices', level: 'read' },
    handler: async (ctx, input) => {
        await device(ctx, input.deviceId);
        const usage = await ctx.db.processSamples.storage(input.deviceId);
        return { deviceId: input.deviceId, ...usage };
    }
});

export const devicesDeleteSnapshotsFeature: FeatureDefinition<
    typeof devicesDeleteSnapshots.command,
    typeof devicesDeleteSnapshots.input,
    typeof devicesDeleteSnapshots.output
> = defineFeature({
    ...devicesDeleteSnapshots,
    mutates: true,
    // Effacer définitivement l'historique d'une machine n'est pas de la lecture,
    // et la garde qui couvrait cette commande s'appelait littéralement
    // `authorizeRead` : tout membre de l'espace pouvait supprimer les relevés
    // conservés par un autre.
    access: { feature: 'devices', level: 'write' },
    handler: async (ctx, input) => {
        const row = await device(ctx, input.deviceId);
        const { snapshots } = await ctx.db.processSamples.deleteRange(input.deviceId, input.from, input.to);
        if (snapshots > 0) {
            const single = input.from === input.to;
            ctx.audit({
                action: 'devices.deleteSnapshots',
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

export const devicesSetSnapshotsPinnedFeature: FeatureDefinition<
    typeof devicesSetSnapshotsPinned.command,
    typeof devicesSetSnapshotsPinned.input,
    typeof devicesSetSnapshotsPinned.output
> = defineFeature({
    ...devicesSetSnapshotsPinned,
    mutates: true,
    // Épingler soustrait des relevés à la purge, désépingler les y rend — et
    // peut en supprimer sur-le-champ. Même niveau que la suppression.
    access: { feature: 'devices', level: 'write' },
    handler: async (ctx, input) => {
        const row = await device(ctx, input.deviceId);
        const { deviceId, from, to, pinned } = input;

        // Pin/unpin the whole instant (process list + metric point) so a saved
        // moment stays fully consultable past the device's retention. Le compte
        // porte sur les instants **métriques** : une machine en
        // `processCapture: 'off'` n'a aucune liste de processus, et le compter
        // sur elles rendait « 0 épinglé » — sans la moindre ligne de journal —
        // alors que les relevés venaient bien d'être conservés.
        const snapshots = await ctx.db.metrics.setInstantsPinned(deviceId, from, to, pinned);

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
                action: 'devices.setSnapshotsPinned',
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
    devicesMetricsFeature,
    devicesPresenceFeature,
    devicesProcessesAtFeature,
    devicesAvailabilityFeature,
    devicesSnapshotsFeature,
    devicesStorageFeature,
    devicesDeleteSnapshotsFeature,
    devicesSetSnapshotsPinnedFeature
];
