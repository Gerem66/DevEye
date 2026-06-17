import type { MetricRow, MetricSnapshot, MetricsResolution } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface MetricsRepo {
    insertBatch(deviceId: string, snapshots: MetricSnapshot[]): Promise<void>;
    query(input: {
        deviceId: string;
        from: number;
        to: number;
        resolution: MetricsResolution;
    }): Promise<MetricSnapshot[]>;
    latest(deviceId: string): Promise<MetricSnapshot | null>;
    pruneOlderThan(cutoffMs: number): Promise<number>;
}

const BUCKET_SECONDS: Record<MetricsResolution, number> = {
    raw: 0,
    minute: 60,
    hour: 3600,
    day: 86400
};

function rowToSnapshot(r: MetricRow): MetricSnapshot {
    return {
        timestamp: Number(r.ts),
        cpuPercent: Number(r.cpu_percent),
        memUsedBytes: Number(r.mem_used_bytes),
        memTotalBytes: Number(r.mem_total_bytes),
        diskUsedBytes: Number(r.disk_used_bytes),
        diskTotalBytes: Number(r.disk_total_bytes),
        netRxBytes: Number(r.net_rx_bytes),
        netTxBytes: Number(r.net_tx_bytes),
        usersCount: Number(r.users_count)
    };
}

export function metricsRepo(pool: Q): MetricsRepo {
    return {
        async insertBatch(deviceId, snapshots) {
            if (snapshots.length === 0) return;
            const values = snapshots.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
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
                    s.usersCount
                );
            }
            await pool.query(
                `INSERT INTO device_metrics
                    (device_id, ts, cpu_percent, mem_used_bytes, mem_total_bytes,
                     disk_used_bytes, disk_total_bytes, net_rx_bytes, net_tx_bytes, users_count)
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
                     MAX(users_count)           AS users_count
                 FROM device_metrics
                 WHERE device_id = ? AND ts BETWEEN ? AND ?
                 GROUP BY FLOOR(ts / ?)
                 ORDER BY ts ASC
                 LIMIT 5000`,
                [bucketMs, bucketMs, deviceId, from, to, bucketMs]
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
        async pruneOlderThan(cutoffMs) {
            const r = await pool.query('DELETE FROM device_metrics WHERE ts < ?', [cutoffMs]);
            return r.rowCount;
        }
    };
}
