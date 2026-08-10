import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';

import { reportProcessSchema, type ProcessKind, type ProcessSample, type ReportProcess } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Don't return a process sample further than this from the requested instant.
 * Metric rows and process samples now share the exact same `ts` (both come from
 * one agent tick), so this only absorbs the case where the requested instant
 * falls between two stored ones — a couple of cadences is plenty.
 */
const NEAREST_TOLERANCE_MS = 5 * 60 * 1000;

/** One stored instant: the process list lives in `payload` as gzipped JSON. */
interface ProcessSampleRow {
    ts: number;
    kind: ProcessKind;
    payload: Buffer;
}

export interface SnapshotStorage {
    /** Snapshot instants stored (one row each). */
    snapshots: number;
    /** Total process entries recorded across those instants. */
    processes: number;
    /** Bytes the compressed blobs occupy — measured, not estimated. */
    bytes: number;
}

/** Snapshot instants in a window, split into all vs the pinned subset. */
export interface SnapshotTimes {
    timestamps: number[];
    pinned: number[];
}

export interface ProcessSamplesRepo {
    /**
     * Store the process list captured at `ts`. The timestamp comes from the
     * metric snapshot it travelled with, so a graph point and its processes are
     * always keyed identically. Re-sending an instant overwrites it.
     */
    insertSample(deviceId: string, ts: number, kind: ProcessKind, processes: ReportProcess[]): Promise<void>;
    /** The process list captured nearest `at` (within tolerance), else null. */
    nearest(deviceId: string, at: number): Promise<ProcessSample | null>;
    /** Snapshot timestamps within [from, to], ascending (timeline marks). */
    snapshotTimes(deviceId: string, from: number, to: number): Promise<SnapshotTimes>;
    /** Storage taken by a device's stored snapshots. */
    storage(deviceId: string): Promise<SnapshotStorage>;
    /** Delete snapshots whose `ts` falls in [from, to] (inclusive). */
    deleteRange(deviceId: string, from: number, to: number): Promise<{ snapshots: number }>;
    /** Set the pinned flag on every instant in [from, to]; returns instants touched. */
    setPinnedRange(deviceId: string, from: number, to: number, pinned: boolean): Promise<{ snapshots: number }>;
    /**
     * Delete unpinned instants in [from, to] already past the device's
     * retention (used right after unpinning). Returns instants removed.
     */
    deleteExpiredInRange(
        deviceId: string,
        from: number,
        to: number,
        defaultDays: number
    ): Promise<{ snapshots: number }>;
    /** Delete samples past each device's retention (NULL → default); skips pinned. */
    pruneByRetention(defaultDays: number): Promise<number>;
}

export function processSamplesRepo(pool: Q): ProcessSamplesRepo {
    async function nearestTs(deviceId: string, at: number): Promise<number | null> {
        const [before, after] = await Promise.all([
            pool.query<{ ts: number }>(
                'SELECT ts FROM device_process_samples WHERE device_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1',
                [deviceId, at]
            ),
            pool.query<{ ts: number }>(
                'SELECT ts FROM device_process_samples WHERE device_id = ? AND ts >= ? ORDER BY ts ASC LIMIT 1',
                [deviceId, at]
            )
        ]);
        const b = before.rows[0] ? Number(before.rows[0].ts) : null;
        const a = after.rows[0] ? Number(after.rows[0].ts) : null;
        if (b === null) return a;
        if (a === null) return b;
        return at - b <= a - at ? b : a;
    }

    /** Count instants in [from, to] — a pin/unpin reports how many it touched. */
    async function countRange(deviceId: string, from: number, to: number): Promise<number> {
        const r = await pool.query<{ snapshots: number }>(
            `SELECT COUNT(*) AS snapshots FROM device_process_samples
             WHERE device_id = ? AND ts BETWEEN ? AND ?`,
            [deviceId, from, to]
        );
        return Number(r.rows[0]?.snapshots ?? 0);
    }

    return {
        async insertSample(deviceId, ts, kind, processes) {
            if (processes.length === 0) return;
            const payload = await gzipAsync(Buffer.from(JSON.stringify(processes), 'utf8'));
            // `payload_bytes` est mesuré ici une fois pour toutes : le calculer
            // à la lecture obligeait `storage()` à relire chaque blob hors page.
            await pool.query(
                `INSERT INTO device_process_samples (device_id, ts, kind, proc_count, payload_bytes, payload)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE kind = VALUES(kind), proc_count = VALUES(proc_count),
                                         payload_bytes = VALUES(payload_bytes), payload = VALUES(payload)`,
                [deviceId, ts, kind, processes.length, payload.length, payload]
            );
        },
        async nearest(deviceId, at) {
            const ts = await nearestTs(deviceId, at);
            if (ts === null || Math.abs(ts - at) > NEAREST_TOLERANCE_MS) return null;
            const r = await pool.query<ProcessSampleRow>(
                'SELECT ts, kind, payload FROM device_process_samples WHERE device_id = ? AND ts = ?',
                [deviceId, ts]
            );
            const row = r.rows[0];
            if (!row) return null;
            // A blob that fails to inflate or parse is corrupt storage, not a
            // client error: report "no sample" rather than breaking the panel.
            let processes: ReportProcess[];
            try {
                const json = (await gunzipAsync(row.payload)).toString('utf8');
                processes = reportProcessSchema.array().parse(JSON.parse(json));
            } catch {
                return null;
            }
            return { ts, kind: row.kind, processes };
        },
        async snapshotTimes(deviceId, from, to) {
            const r = await pool.query<{ ts: number; pinned: number }>(
                `SELECT ts, pinned FROM device_process_samples
                 WHERE device_id = ? AND ts BETWEEN ? AND ?
                 ORDER BY ts ASC
                 LIMIT 5000`,
                [deviceId, from, to]
            );
            const timestamps: number[] = [];
            const pinned: number[] = [];
            for (const row of r.rows) {
                const ts = Number(row.ts);
                timestamps.push(ts);
                if (Number(row.pinned) === 1) pinned.push(ts);
            }
            return { timestamps, pinned };
        },
        async storage(deviceId) {
            const r = await pool.query<{ snapshots: number; processes: number; bytes: number }>(
                `SELECT COUNT(*)                          AS snapshots,
                        COALESCE(SUM(proc_count), 0)      AS processes,
                        COALESCE(SUM(payload_bytes), 0)   AS bytes
                 FROM device_process_samples WHERE device_id = ?`,
                [deviceId]
            );
            const row = r.rows[0];
            return {
                snapshots: Number(row?.snapshots ?? 0),
                processes: Number(row?.processes ?? 0),
                bytes: Number(row?.bytes ?? 0)
            };
        },
        async deleteRange(deviceId, from, to) {
            const del = await pool.query(
                'DELETE FROM device_process_samples WHERE device_id = ? AND ts BETWEEN ? AND ?',
                [deviceId, from, to]
            );
            return { snapshots: del.rowCount };
        },
        async setPinnedRange(deviceId, from, to, pinned) {
            const snapshots = await countRange(deviceId, from, to);
            await pool.query(
                `UPDATE device_process_samples SET pinned = ?
                 WHERE device_id = ? AND ts BETWEEN ? AND ?`,
                [pinned ? 1 : 0, deviceId, from, to]
            );
            return { snapshots };
        },
        async deleteExpiredInRange(deviceId, from, to, defaultDays) {
            const del = await pool.query(
                `DELETE s FROM device_process_samples s
                 JOIN devices d ON d.id = s.device_id
                 WHERE s.device_id = ? AND s.ts BETWEEN ? AND ?
                   AND s.pinned = 0 AND d.status <> 'archived'
                   AND s.ts < (UNIX_TIMESTAMP() * 1000) - COALESCE(d.retention_days, ?) * 86400000`,
                [deviceId, from, to, defaultDays]
            );
            return { snapshots: del.rowCount };
        },
        async pruneByRetention(defaultDays) {
            // Même échéance que les métriques et la présence : un relevé est un
            // instant, et les faire expirer séparément ne produisait que des
            // instants à moitié lisibles. Les lignes épinglées survivent quel
            // que soit leur âge.
            const r = await pool.query(
                `DELETE s FROM device_process_samples s
                 JOIN devices d ON d.id = s.device_id
                 WHERE s.pinned = 0
                   AND d.status <> 'archived'
                   AND s.ts < (UNIX_TIMESTAMP() * 1000) - COALESCE(d.retention_days, ?) * 86400000`,
                [defaultDays]
            );
            return r.rowCount;
        }
    };
}
