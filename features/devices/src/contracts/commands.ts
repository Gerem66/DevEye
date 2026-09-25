import { z } from 'zod';
import {
    deviceSchema,
    metricSeriesPointSchema,
    metricsResolutionSchema,
    processCaptureSchema,
    processSampleSchema,
    terminalUser,
    linkCodeRequestSchema,
    linkCodeResponseSchema,
    linkCodesListResponseSchema,
    linkCodeUpdateSchema,
    presenceEventSchema
} from '@deveye/types';

/**
 * La feature Appareils : le cycle de vie d'un appareil, sa configuration de
 * collecte, son partage entre espaces, l'historique lu en base et les codes de
 * liaison. Tout ce qui relaie un ordre à l'agent est du transport (`agent.*`).
 */

const deviceId = z.uuid();

/**
 * Un appareil tel que la flotte le rend : le domaine public, plus
 * `planPaused`, l'offre de son propriétaire qui le tient en pause (son agent est
 * refusé, rien n'en est relevé). Distinct de `status`, qui reste celui choisi.
 */
export const fleetDeviceSchema = deviceSchema.extend({ planPaused: z.boolean() });
export type FleetDevice = z.infer<typeof fleetDeviceSchema>;

/** List devices visible to the caller (own devices; all devices for admins). */
/** Les appareils que l'espace actif voit : les siens, et ceux qui y sont projetés. */
export const devicesList = {
    command: 'devices.list' as const,
    input: z.object({}),
    output: z.object({ devices: z.array(fleetDeviceSchema) })
};

/** Confirm a `pending` device, moving it to `active`. */
export const devicesConfirm = {
    command: 'devices.confirm' as const,
    input: z.object({ deviceId }),
    output: z.object({ device: fleetDeviceSchema })
};

/** Revoke a device: its token is rejected and it can no longer push metrics. */
export const devicesRevoke = {
    command: 'devices.revoke' as const,
    input: z.object({ deviceId }),
    output: z.object({ device: fleetDeviceSchema })
};

/**
 * Lay out the workspace's devices: `ids` is the complete list in its final
 * order. Gated on `devices: write` rather than `admin: true`: arranging a list
 * one's own workspace displays is not fleet management. Touches no agent state.
 */
export const devicesReorder = {
    command: 'devices.reorder' as const,
    input: z.object({ ids: z.array(deviceId).min(1) }),
    output: z.object({ ids: z.array(deviceId) })
};

export const devicesRename = {
    command: 'devices.rename' as const,
    input: z.object({ deviceId, name: z.string().min(1).max(128) }),
    output: z.object({ device: fleetDeviceSchema })
};

/**
 * Update a device's config: what its agent collects, and how its remote
 * terminal opens. Every field is optional; only the provided ones change.
 * `null` resets a field to the server default. Interval or capture changes are
 * pushed live to a connected agent.
 */
export const devicesSetConfig = {
    command: 'devices.setConfig' as const,
    input: z
        .object({
            deviceId,
            /** Collection interval in seconds — metrics *and* processes (5s–1h). */
            metricIntervalSeconds: z.number().int().min(5).max(3600).nullable().optional(),
            processCapture: processCaptureSchema.nullable().optional(),
            /** Conservation de l'historique — métriques, présence et processus. */
            retentionDays: z.number().int().positive().max(3650).nullable().optional(),
            /** Compte d'ouverture des sessions ; `null` : celui de l'agent. */
            terminalDefaultUser: terminalUser.nullable().optional(),
            terminalCloseOnExit: z.boolean().optional()
        })
        .refine(
            (v) =>
                v.metricIntervalSeconds !== undefined ||
                v.processCapture !== undefined ||
                v.retentionDays !== undefined ||
                v.terminalDefaultUser !== undefined ||
                v.terminalCloseOnExit !== undefined,
            { message: 'No config field provided' }
        ),
    output: z.object({ device: fleetDeviceSchema })
};

/** Reactivate a revoked device, moving it back to `active`. */
export const devicesReactivate = {
    command: 'devices.reactivate' as const,
    input: z.object({ deviceId }),
    output: z.object({ device: fleetDeviceSchema })
};

/**
 * Request a managed deletion. The device moves to `pending_deletion`: the agent
 * is told to self-destruct (now if online, else on its next connection), after
 * which the device is archived, its monitoring history kept.
 */
export const devicesRequestDelete = {
    command: 'devices.requestDelete' as const,
    input: z.object({ deviceId }),
    output: z.object({ device: fleetDeviceSchema })
};

/** Cancel a `pending_deletion` (only effective while the agent hasn't reconnected). */
export const devicesCancelDelete = {
    command: 'devices.cancelDelete' as const,
    input: z.object({ deviceId }),
    output: z.object({ device: fleetDeviceSchema })
};

/**
 * Archive the device now without waiting for the agent to self-destruct (the
 * agent is gone, or nobody cares if it cleans up); if it ever reconnects it's refused.
 */
export const devicesForceDelete = {
    command: 'devices.forceDelete' as const,
    input: z.object({ deviceId }),
    output: z.object({ device: fleetDeviceSchema })
};

/**
 * Hard-purge a device and ALL its monitoring history, agent online or not; it
 * does not self-destruct the agent.
 */
export const devicesDelete = {
    command: 'devices.delete' as const,
    input: z.object({ deviceId }),
    output: z.object({ deviceId })
};

const lifecycleCommands = [
    devicesList,
    devicesConfirm,
    devicesRevoke,
    devicesReactivate,
    devicesRename,
    devicesReorder,
    devicesSetConfig,
    devicesRequestDelete,
    devicesCancelDelete,
    devicesForceDelete,
    devicesDelete
] as const;

/**
 * L'historique d'un appareil, lu et entretenu en base : métriques, présence,
 * processus, instants épinglés. La part de la feature qui ne parle jamais à
 * l'agent ; l'abonnement en direct et la collecte à la demande sont du
 * transport (`agent.subscribe`, `agent.collect`).
 */

/** Fetch a time-series window for graphs, optionally downsampled. */
export const devicesMetrics = {
    command: 'devices.metrics' as const,
    input: z.object({
        deviceId,
        from: z.number().int().nonnegative(),
        to: z.number().int().positive(),
        resolution: metricsResolutionSchema.default('raw')
    }),
    output: z.object({
        deviceId,
        points: z.array(metricSeriesPointSchema)
    })
};

/** Agent connectivity over a window, to draw the uptime timeline. */
export const devicesPresence = {
    command: 'devices.presence' as const,
    input: z.object({
        deviceId,
        from: z.number().int().nonnegative(),
        to: z.number().int().positive()
    }),
    output: z.object({
        deviceId,
        /** Online state at `from` (carried over from the last prior event). */
        onlineAtStart: z.boolean(),
        events: z.array(presenceEventSchema)
    })
};

/** Processes captured nearest to a given instant (null if none in range). */
export const devicesProcessesAt = {
    command: 'devices.processesAt' as const,
    input: z.object({ deviceId, at: z.number().int().positive() }),
    output: z.object({ deviceId, sample: processSampleSchema.nullable() })
};

/**
 * Ce qu'un jour local contient, pour le calendrier et sa liste. Le compte
 * d'épingles est l'information qui compte sur la durée : passé la rétention,
 * un jour ne subsiste que par eux.
 */
export const daySummarySchema = z.object({
    /** Jour local, YYYY-MM-DD. */
    day: z.string(),
    /** Instants métriques enregistrés ce jour. */
    instants: z.number().int().positive(),
    /** Ceux qui sont épinglés : ce qui survivra à la rétention. */
    pinned: z.number().int().nonnegative()
});
export type DaySummary = z.infer<typeof daySummarySchema>;

/** Les jours locaux qui portent des données, résumés, pour le calendrier. */
export const devicesAvailability = {
    command: 'devices.availability' as const,
    input: z.object({
        deviceId,
        /** Client UTC offset (`Date.getTimezoneOffset()`), to bucket by local day. */
        tzOffsetMinutes: z.number().int().default(0)
    }),
    output: z.object({ deviceId, days: z.array(daySummarySchema) })
};

/**
 * Timestamps of the stored instants in a window, to mark them on the timeline.
 * `timestamps` are the metric instants (one per collection tick); process
 * capture is optional, so `withProcesses` is the subset that also carries a
 * process list.
 */
export const devicesSnapshots = {
    command: 'devices.snapshots' as const,
    input: z.object({
        deviceId,
        from: z.number().int().nonnegative(),
        to: z.number().int().positive()
    }),
    output: z.object({
        deviceId,
        timestamps: z.array(z.number().int().positive()),
        /** Subset of `timestamps` that are pinned (kept past retention). */
        pinned: z.array(z.number().int().positive()),
        /** Subset of `timestamps` whose process list was recorded. */
        withProcesses: z.array(z.number().int().positive()),
        /**
         * La fenêtre contenait plus d'instants que le plafond : seuls les plus
         * récents sont là, et l'interface le dit.
         */
        truncated: z.boolean().default(false)
    })
};

/**
 * Pin (or unpin) the snapshots within `[from, to]`: process list and metric
 * point survive the device's retention. Unpinning lets them expire again; rows
 * already past their deadline are deleted immediately.
 */
export const devicesSetSnapshotsPinned = {
    command: 'devices.setSnapshotsPinned' as const,
    input: z
        .object({
            deviceId,
            from: z.number().int().nonnegative(),
            to: z.number().int().positive(),
            pinned: z.boolean()
        })
        .refine((v) => v.to >= v.from, { message: 'to must be >= from' }),
    output: z.object({
        deviceId,
        /** Snapshot instants whose pin state changed. */
        affected: z.number().int().nonnegative(),
        /** Snapshot instants deleted right away on unpin (already past retention). */
        deletedSnapshots: z.number().int().nonnegative()
    })
};

/** Storage footprint of a device's stored process snapshots (count + bytes). */
export const devicesStorage = {
    command: 'devices.storage' as const,
    input: z.object({ deviceId }),
    output: z.object({
        deviceId,
        /** Snapshot instants kept for the device (one stored row each). */
        snapshots: z.number().int().nonnegative(),
        /** Total process entries recorded across those instants. */
        processes: z.number().int().nonnegative(),
        /** Bytes the compressed process blobs occupy — measured, not estimated. */
        bytes: z.number().int().nonnegative()
    })
};

/**
 * Delete the process snapshots within `[from, to]` (inclusive). A single snapshot
 * is removed by passing `from === to === ts`; a dragged zone passes its bounds.
 */
export const devicesDeleteSnapshots = {
    command: 'devices.deleteSnapshots' as const,
    input: z
        .object({
            deviceId,
            from: z.number().int().nonnegative(),
            to: z.number().int().positive()
        })
        .refine((v) => v.to >= v.from, { message: 'to must be >= from' }),
    output: z.object({
        deviceId,
        /** Snapshot instants removed. */
        deletedSnapshots: z.number().int().nonnegative()
    })
};

const metricsCommands = [
    devicesMetrics,
    devicesPresence,
    devicesProcessesAt,
    devicesAvailability,
    devicesSnapshots,
    devicesStorage,
    devicesDeleteSnapshots,
    devicesSetSnapshotsPinned
] as const;

/**
 * Les codes de liaison : ce qu'un administrateur émet pour enrôler une machine
 * (l'agent le présente à `POST /api/devices/enroll`, route publique de
 * l'infrastructure, qui reste en HTTP).
 */
export const devicesLinkCodeCreate = {
    command: 'devices.linkCodeCreate' as const,
    input: linkCodeRequestSchema,
    output: linkCodeResponseSchema
};

export const devicesLinkCodeList = {
    command: 'devices.linkCodeList' as const,
    input: z.object({}),
    output: linkCodesListResponseSchema
};

export const devicesLinkCodeSetAutoApprove = {
    command: 'devices.linkCodeSetAutoApprove' as const,
    input: linkCodeUpdateSchema.extend({ code: z.string().min(1) }),
    output: linkCodeResponseSchema
};

export const devicesLinkCodeRevoke = {
    command: 'devices.linkCodeRevoke' as const,
    input: z.object({ code: z.string().min(1) }),
    output: z.object({ code: z.string() })
};

const linkCodeCommands = [
    devicesLinkCodeCreate,
    devicesLinkCodeList,
    devicesLinkCodeSetAutoApprove,
    devicesLinkCodeRevoke
] as const;

/** Toutes les commandes du module : la flotte, les métriques stockées, les codes de liaison. */
export const devicesCommands = [...lifecycleCommands, ...metricsCommands, ...linkCodeCommands] as const;
