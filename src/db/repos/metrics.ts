import type { MetricRow, MetricSeriesPoint, MetricSnapshot, MetricsResolution } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface MetricsRepo {
    insertBatch(deviceId: string, snapshots: MetricSnapshot[]): Promise<void>;
    query(input: {
        deviceId: string;
        from: number;
        to: number;
        resolution: MetricsResolution;
    }): Promise<MetricSeriesPoint[]>;
    latest(deviceId: string): Promise<MetricSeriesPoint | null>;
    /**
     * Distinct local days (YYYY-MM-DD) that have samples, ascending, bucketed in
     * the client's timezone (`tzOffsetMinutes` = `Date.getTimezoneOffset()`).
     */
    availableDays(deviceId: string, tzOffsetMinutes: number): Promise<string[]>;
    /**
     * Timestamps of the stored instants within [from, to], ascending, split into
     * all vs the pinned subset — the timeline's marks. Keyed on the metric rows
     * (one per collection tick) rather than on the process samples, which are
     * optional: a device with `processCapture: 'off'` still has instants to
     * navigate.
     */
    instantTimes(deviceId: string, from: number, to: number): Promise<{ timestamps: number[]; pinned: number[] }>;
    /** Set the pinned flag on every metric row in [from, to] for a device. */
    setPinnedRange(deviceId: string, from: number, to: number, pinned: boolean): Promise<void>;
    /**
     * Delete unpinned metric rows in [from, to] already past the device's
     * retention (used right after unpinning). Returns rows removed.
     */
    deleteExpiredInRange(deviceId: string, from: number, to: number, defaultDays: number): Promise<number>;
    /** Delete samples past each device's retention (NULL → `defaultDays`); skips pinned. */
    pruneByRetention(defaultDays: number): Promise<number>;
}

const BUCKET_SECONDS: Record<MetricsResolution, number> = {
    raw: 0,
    minute: 60,
    hour: 3600,
    day: 86400
};

/** Coerce a possibly-null float column to a number or null. */
function num(v: number | null): number | null {
    return v === null || v === undefined ? null : Number(v);
}

/**
 * Coerce a possibly-null integer column. Downsampled rows use `AVG()`, which
 * yields decimals on integer-typed columns; round so they satisfy the `.int()`
 * output schema (raw rows are already integral, so rounding is a no-op there).
 */
function intNum(v: number | null): number | null {
    return v === null || v === undefined ? null : Math.round(Number(v));
}

function rowToSnapshot(r: MetricRow): MetricSeriesPoint {
    return {
        timestamp: Math.round(Number(r.ts)),
        cpuPercent: Number(r.cpu_percent),
        memUsedBytes: intNum(r.mem_used_bytes) as number,
        memTotalBytes: intNum(r.mem_total_bytes) as number,
        diskUsedBytes: intNum(r.disk_used_bytes) as number,
        diskTotalBytes: intNum(r.disk_total_bytes) as number,
        netRxBytes: intNum(r.net_rx_bytes) as number,
        netTxBytes: intNum(r.net_tx_bytes) as number,
        usersCount: intNum(r.users_count) as number,
        loadAvg1: num(r.load_avg_1),
        cpuTempC: num(r.cpu_temp_c),
        uptimeSeconds: intNum(r.uptime_seconds),
        processCount: intNum(r.process_count),
        activeConnections: intNum(r.active_connections),
        gpuPercent: num(r.gpu_percent),
        diskReadBytes: intNum(r.disk_read_bytes),
        diskWriteBytes: intNum(r.disk_write_bytes),
        batteryPercent: num(r.battery_percent),
        batteryCharging: r.battery_charging === null ? null : Number(r.battery_charging) === 1
    };
}

export function metricsRepo(pool: Q): MetricsRepo {
    return {
        async insertBatch(deviceId, snapshots) {
            if (snapshots.length === 0) return;
            const values = snapshots
                .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .join(', ');
            const params: unknown[] = [];
            for (const s of snapshots) {
                params.push(
                    deviceId,
                    s.timestamp,
                    s.cpuPercent,
                    s.memUsedBytes,
                    s.memTotalBytes,
                    s.diskUsedBytes,
                    s.diskTotalBytes,
                    s.netRxBytes,
                    s.netTxBytes,
                    s.usersCount,
                    s.loadAvg1 ?? null,
                    s.cpuTempC ?? null,
                    s.uptimeSeconds ?? null,
                    s.processCount ?? null,
                    s.activeConnections ?? null,
                    s.gpuPercent ?? null,
                    s.diskReadBytes ?? null,
                    s.diskWriteBytes ?? null,
                    s.batteryPercent ?? null,
                    s.batteryCharging === null || s.batteryCharging === undefined ? null : s.batteryCharging ? 1 : 0
                );
            }
            await pool.query(
                `INSERT INTO device_metrics
                    (device_id, ts, cpu_percent, mem_used_bytes, mem_total_bytes,
                     disk_used_bytes, disk_total_bytes, net_rx_bytes, net_tx_bytes, users_count,
                     load_avg_1, cpu_temp_c, uptime_seconds, process_count, active_connections, gpu_percent,
                     disk_read_bytes, disk_write_bytes, battery_percent, battery_charging)
                 VALUES ${values}`,
                params
            );
        },
        async query({ deviceId, from, to, resolution }) {
            if (resolution === 'raw') {
                const r = await pool.query<MetricRow>(
                    `SELECT * FROM device_metrics
                     WHERE device_id = ? AND ts BETWEEN ? AND ?
                     ORDER BY ts ASC
                     LIMIT 5000`,
                    [deviceId, from, to]
                );
                return r.rows.map(rowToSnapshot);
            }

            // Downsample by time bucket (averages for gauges, max for counters).
            const bucketMs = BUCKET_SECONDS[resolution] * 1000;
            const r = await pool.query<MetricRow & { bucket: number }>(
                `SELECT
                     (FLOOR(ts / ?) * ?)        AS ts,
                     AVG(cpu_percent)           AS cpu_percent,
                     AVG(mem_used_bytes)        AS mem_used_bytes,
                     MAX(mem_total_bytes)       AS mem_total_bytes,
                     AVG(disk_used_bytes)       AS disk_used_bytes,
                     MAX(disk_total_bytes)      AS disk_total_bytes,
                     MAX(net_rx_bytes)          AS net_rx_bytes,
                     MAX(net_tx_bytes)          AS net_tx_bytes,
                     MAX(users_count)           AS users_count,
                     AVG(load_avg_1)            AS load_avg_1,
                     AVG(cpu_temp_c)            AS cpu_temp_c,
                     MAX(uptime_seconds)        AS uptime_seconds,
                     AVG(process_count)         AS process_count,
                     AVG(active_connections)    AS active_connections,
                     AVG(gpu_percent)           AS gpu_percent,
                     MAX(disk_read_bytes)       AS disk_read_bytes,
                     MAX(disk_write_bytes)      AS disk_write_bytes,
                     AVG(battery_percent)       AS battery_percent,
                     MAX(battery_charging)      AS battery_charging
                 FROM device_metrics
                 WHERE device_id = ? AND ts BETWEEN ? AND ?
                 GROUP BY (FLOOR(ts / ?) * ?)
                 ORDER BY ts ASC
                 LIMIT 5000`,
                [bucketMs, bucketMs, deviceId, from, to, bucketMs, bucketMs]
            );
            return r.rows.map(rowToSnapshot);
        },
        async latest(deviceId) {
            const r = await pool.query<MetricRow>(
                'SELECT * FROM device_metrics WHERE device_id = ? ORDER BY ts DESC LIMIT 1',
                [deviceId]
            );
            return r.rows[0] ? rowToSnapshot(r.rows[0]) : null;
        },
        async availableDays(deviceId, tzOffsetMinutes) {
            // Bucket by *local* day using pure integer math so the result is
            // independent of the MySQL/Node session timezone. `getTimezoneOffset`
            // is (UTC - local) in minutes, so local-ms = ts - offset*60000.
            const offsetMs = tzOffsetMinutes * 60000;
            const dayMs = 86400000;
            const r = await pool.query<{ d: number }>(
                `SELECT DISTINCT FLOOR((ts - ?) / ?) AS d
                 FROM device_metrics WHERE device_id = ?
                 ORDER BY d ASC`,
                [offsetMs, dayMs, deviceId]
            );
            // Day index → 'YYYY-MM-DD': index*dayMs is local midnight expressed as
            // a UTC instant, so formatting it as UTC yields the local calendar day.
            return r.rows.map((row) => new Date(Number(row.d) * dayMs).toISOString().slice(0, 10));
        },
        async instantTimes(deviceId, from, to) {
            // Same shape and bound as `processSamples.snapshotTimes`, so the two
            // sources merge without either side having to handle a different cap.
            const r = await pool.query<{ ts: number; pinned: number }>(
                `SELECT ts, pinned FROM device_metrics
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
        async setPinnedRange(deviceId, from, to, pinned) {
            await pool.query(
                `UPDATE device_metrics SET pinned = ?
                 WHERE device_id = ? AND ts BETWEEN ? AND ?`,
                [pinned ? 1 : 0, deviceId, from, to]
            );
        },
        async deleteExpiredInRange(deviceId, from, to, defaultDays) {
            const r = await pool.query(
                `DELETE m FROM device_metrics m
                 JOIN devices d ON d.id = m.device_id
                 WHERE m.device_id = ? AND m.ts BETWEEN ? AND ?
                   AND m.pinned = 0 AND d.status <> 'archived'
                   AND m.ts < (UNIX_TIMESTAMP() * 1000) - COALESCE(d.retention_days, ?) * 86400000`,
                [deviceId, from, to, defaultDays]
            );
            return r.rowCount;
        },
        async pruneByRetention(defaultDays) {
            const r = await pool.query(
                `DELETE m FROM device_metrics m
                 JOIN devices d ON d.id = m.device_id
                 WHERE m.pinned = 0
                   AND d.status <> 'archived'
                   AND m.ts < (UNIX_TIMESTAMP() * 1000) - COALESCE(d.retention_days, ?) * 86400000`,
                [defaultDays]
            );
            return r.rowCount;
        }
    };
}
