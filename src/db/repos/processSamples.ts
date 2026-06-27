import type { ProcessKind, ProcessSample, ProcessSampleRow, ReportProcess } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/** Don't return a process sample further than this from the requested instant. */
const NEAREST_TOLERANCE_MS = 2 * 60 * 60 * 1000;

/**
 * Byte cost of each fixed-width column of `device_process_samples`, used to
 * estimate a device's snapshot footprint without per-row inspection. Keep this
 * map in sync with the table schema: adding/removing/resizing a column here makes
 * the estimate adapt on its own — no magic total to recompute by hand. The
 * variable-length `name` column is NOT listed; it's added from its real
 * `LENGTH(name)` at query time.
 */
const PROCESS_ROW_COLUMN_BYTES = {
    id: 8, // BIGINT
    device_id: 36, // CHAR(36)
    ts: 8, // BIGINT
    kind: 1, // ENUM('top','full')
    cpu_percent: 4, // FLOAT
    mem_bytes: 8, // BIGINT
    pinned: 1 // TINYINT
} as const;

/**
 * Non-column per-row cost: InnoDB record header + the `(device_id, ts)` secondary
 * index entry + page fill slack. Roughly stable regardless of the columns.
 */
const PROCESS_ROW_OVERHEAD_BYTES = 70;

/** Estimated fixed bytes per stored row (columns + overhead); `name` added on top. */
const EST_FIXED_BYTES_PER_PROCESS_ROW =
    Object.values(PROCESS_ROW_COLUMN_BYTES).reduce((sum, b) => sum + b, 0) + PROCESS_ROW_OVERHEAD_BYTES;

export interface SnapshotStorage {
    /** Distinct snapshot instants. */
    snapshots: number;
    /** Total process rows across those snapshots. */
    rows: number;
    /** Estimated bytes occupied in the database (data + index). */
    bytes: number;
}

/** Snapshot instants in a window, split into all vs the pinned subset. */
export interface SnapshotTimes {
    timestamps: number[];
    pinned: number[];
}

export interface ProcessSamplesRepo {
    insertSample(deviceId: string, sample: ProcessSample): Promise<void>;
    /** The process list captured nearest `at` (within tolerance), else null. */
    nearest(deviceId: string, at: number): Promise<ProcessSample | null>;
    /** Distinct snapshot timestamps within [from, to], ascending (timeline marks). */
    snapshotTimes(deviceId: string, from: number, to: number): Promise<SnapshotTimes>;
    /** Estimated storage taken by a device's stored snapshots. */
    storage(deviceId: string): Promise<SnapshotStorage>;
    /**
     * Delete snapshots whose `ts` falls in [from, to] (inclusive). Returns the
     * number of distinct instants and process rows removed.
     */
    deleteRange(deviceId: string, from: number, to: number): Promise<{ snapshots: number; rows: number }>;
    /** Set the pinned flag on every row in [from, to]; returns distinct instants touched. */
    setPinnedRange(deviceId: string, from: number, to: number, pinned: boolean): Promise<{ snapshots: number }>;
    /**
     * Delete unpinned rows in [from, to] already past the device's process
     * retention (used right after unpinning). Returns instants and rows removed.
     */
    deleteExpiredInRange(
        deviceId: string,
        from: number,
        to: number,
        defaultDays: number
    ): Promise<{ snapshots: number; rows: number }>;
    /** Delete samples past each device's process retention (NULL → default); skips pinned. */
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

    return {
        async insertSample(deviceId, sample) {
            if (sample.processes.length === 0) return;
            const values = sample.processes.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
            const params: unknown[] = [];
            for (const p of sample.processes) {
                params.push(deviceId, sample.ts, sample.kind, p.name, p.cpuPercent, p.memBytes);
            }
            await pool.query(
                `INSERT INTO device_process_samples (device_id, ts, kind, name, cpu_percent, mem_bytes)
                 VALUES ${values}`,
                params
            );
        },
        async nearest(deviceId, at) {
            const ts = await nearestTs(deviceId, at);
            if (ts === null || Math.abs(ts - at) > NEAREST_TOLERANCE_MS) return null;
            const r = await pool.query<ProcessSampleRow>(
                `SELECT kind, name, cpu_percent, mem_bytes FROM device_process_samples
                 WHERE device_id = ? AND ts = ?
                 ORDER BY cpu_percent DESC`,
                [deviceId, ts]
            );
            if (r.rows.length === 0) return null;
            const kind = r.rows[0].kind as ProcessKind;
            const processes: ReportProcess[] = r.rows.map((row) => ({
                name: row.name,
                cpuPercent: Number(row.cpu_percent),
                memBytes: Number(row.mem_bytes)
            }));
            return { ts, kind, processes };
        },
        async snapshotTimes(deviceId, from, to) {
            // MAX(pinned): a snapshot instant counts as pinned as soon as any of
            // its process rows is pinned (pin/unpin always sets the whole instant).
            const r = await pool.query<{ ts: number; pinned: number }>(
                `SELECT ts, MAX(pinned) AS pinned FROM device_process_samples
                 WHERE device_id = ? AND ts BETWEEN ? AND ?
                 GROUP BY ts
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
            const r = await pool.query<{ total: number; snapshots: number; name_bytes: number }>(
                `SELECT COUNT(*)                       AS total,
                        COUNT(DISTINCT ts)             AS snapshots,
                        COALESCE(SUM(LENGTH(name)), 0) AS name_bytes
                 FROM device_process_samples WHERE device_id = ?`,
                [deviceId]
            );
            const row = r.rows[0];
            const rows = Number(row?.total ?? 0);
            const nameBytes = Number(row?.name_bytes ?? 0);
            return {
                snapshots: Number(row?.snapshots ?? 0),
                rows,
                bytes: rows * EST_FIXED_BYTES_PER_PROCESS_ROW + nameBytes
            };
        },
        async deleteRange(deviceId, from, to) {
            const counted = await pool.query<{ snapshots: number }>(
                `SELECT COUNT(DISTINCT ts) AS snapshots FROM device_process_samples
                 WHERE device_id = ? AND ts BETWEEN ? AND ?`,
                [deviceId, from, to]
            );
            const del = await pool.query(
                `DELETE FROM device_process_samples WHERE device_id = ? AND ts BETWEEN ? AND ?`,
                [deviceId, from, to]
            );
            return { snapshots: Number(counted.rows[0]?.snapshots ?? 0), rows: del.rowCount };
        },
        async setPinnedRange(deviceId, from, to, pinned) {
            const counted = await pool.query<{ snapshots: number }>(
                `SELECT COUNT(DISTINCT ts) AS snapshots FROM device_process_samples
                 WHERE device_id = ? AND ts BETWEEN ? AND ?`,
                [deviceId, from, to]
            );
            await pool.query(
                `UPDATE device_process_samples SET pinned = ?
                 WHERE device_id = ? AND ts BETWEEN ? AND ?`,
                [pinned ? 1 : 0, deviceId, from, to]
            );
            return { snapshots: Number(counted.rows[0]?.snapshots ?? 0) };
        },
        async deleteExpiredInRange(deviceId, from, to, defaultDays) {
            const counted = await pool.query<{ snapshots: number }>(
                `SELECT COUNT(DISTINCT s.ts) AS snapshots FROM device_process_samples s
                 JOIN devices d ON d.id = s.device_id
                 WHERE s.device_id = ? AND s.ts BETWEEN ? AND ?
                   AND s.pinned = 0 AND d.status <> 'archived'
                   AND s.ts < (UNIX_TIMESTAMP() * 1000) - COALESCE(d.process_retention_days, ?) * 86400000`,
                [deviceId, from, to, defaultDays]
            );
            const del = await pool.query(
                `DELETE s FROM device_process_samples s
                 JOIN devices d ON d.id = s.device_id
                 WHERE s.device_id = ? AND s.ts BETWEEN ? AND ?
                   AND s.pinned = 0 AND d.status <> 'archived'
                   AND s.ts < (UNIX_TIMESTAMP() * 1000) - COALESCE(d.process_retention_days, ?) * 86400000`,
                [deviceId, from, to, defaultDays]
            );
            return { snapshots: Number(counted.rows[0]?.snapshots ?? 0), rows: del.rowCount };
        },
        async pruneByRetention(defaultDays) {
            // Process history has its own (shorter) retention; it's the bulkiest data.
            // Pinned rows are kept regardless of age.
            const r = await pool.query(
                `DELETE s FROM device_process_samples s
                 JOIN devices d ON d.id = s.device_id
                 WHERE s.pinned = 0
                   AND d.status <> 'archived'
                   AND s.ts < (UNIX_TIMESTAMP() * 1000) - COALESCE(d.process_retention_days, ?) * 86400000`,
                [defaultDays]
            );
            return r.rowCount;
        }
    };
}
