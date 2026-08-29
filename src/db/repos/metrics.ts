import type { MetricRow, MetricSeriesPoint, MetricSnapshot, MetricsResolution } from '@deveye/types';
import type { Queryable } from '../pool';

type Q = Queryable;

/**
 * Le dépôt du socle : l'ingestion (`insertBatch`), l'instant poussé à
 * l'ouverture d'un abonnement (`latest`) et ce que la façade `telemetry` du
 * SDK lit et épingle. Les fenêtres des graphes, la frise et les purges sont les
 * requêtes du module `features/devices`, sur cette même table.
 */
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
     * Épingle (ou désépingle) les **instants** de [from, to] : la ligne métrique
     * et, quand elle existe, la liste de processus du même horodatage. Rend le
     * nombre d'instants concernés.
     */
    setInstantsPinned(deviceId: string, from: number, to: number, pinned: boolean): Promise<number>;
}

const BUCKET_SECONDS: Record<MetricsResolution, number> = {
    raw: 0,
    minute: 60,
    hour: 3600
};

/**
 * Plafond de lecture d'une fenêtre, simple garde-fou (la résolution réduit
 * déjà). La sélection prend les plus récents : la queue de la fenêtre est
 * celle qu'on regarde.
 */
const MAX_SERIES_POINTS = 5_000;

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
            // Idempotent : un agent qui rejoue un lot après un accusé perdu
            // réécrit l'instant au lieu de le dédoubler. `pinned` est absent de
            // la clause de mise à jour : un réenvoi ne doit pas désépingler.
            await pool.query(
                `INSERT INTO device_metrics
                    (device_id, ts, cpu_percent, mem_used_bytes, mem_total_bytes,
                     disk_used_bytes, disk_total_bytes, net_rx_bytes, net_tx_bytes, users_count,
                     load_avg_1, cpu_temp_c, uptime_seconds, process_count, active_connections, gpu_percent,
                     disk_read_bytes, disk_write_bytes, battery_percent, battery_charging)
                 VALUES ${values}
                 ON DUPLICATE KEY UPDATE
                     cpu_percent = VALUES(cpu_percent),
                     mem_used_bytes = VALUES(mem_used_bytes),
                     mem_total_bytes = VALUES(mem_total_bytes),
                     disk_used_bytes = VALUES(disk_used_bytes),
                     disk_total_bytes = VALUES(disk_total_bytes),
                     net_rx_bytes = VALUES(net_rx_bytes),
                     net_tx_bytes = VALUES(net_tx_bytes),
                     users_count = VALUES(users_count),
                     load_avg_1 = VALUES(load_avg_1),
                     cpu_temp_c = VALUES(cpu_temp_c),
                     uptime_seconds = VALUES(uptime_seconds),
                     process_count = VALUES(process_count),
                     active_connections = VALUES(active_connections),
                     gpu_percent = VALUES(gpu_percent),
                     disk_read_bytes = VALUES(disk_read_bytes),
                     disk_write_bytes = VALUES(disk_write_bytes),
                     battery_percent = VALUES(battery_percent),
                     battery_charging = VALUES(battery_charging)`,
                params
            );
        },
        async query({ deviceId, from, to, resolution }) {
            if (resolution === 'raw') {
                // Les plus récents, puis remis dans l'ordre : au-delà du
                // plafond, c'est le début de la fenêtre qui doit manquer, pas
                // sa fin.
                const r = await pool.query<MetricRow>(
                    `SELECT * FROM device_metrics
                     WHERE device_id = ? AND ts BETWEEN ? AND ?
                     ORDER BY ts DESC
                     LIMIT ${MAX_SERIES_POINTS}`,
                    [deviceId, from, to]
                );
                return r.rows.reverse().map(rowToSnapshot);
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
                 ORDER BY ts DESC
                 LIMIT ${MAX_SERIES_POINTS}`,
                [bucketMs, bucketMs, deviceId, from, to, bucketMs, bucketMs]
            );
            return r.rows.reverse().map(rowToSnapshot);
        },
        async latest(deviceId) {
            const r = await pool.query<MetricRow>(
                'SELECT * FROM device_metrics WHERE device_id = ? ORDER BY ts DESC LIMIT 1',
                [deviceId]
            );
            return r.rows[0] ? rowToSnapshot(r.rows[0]) : null;
        },
        async setInstantsPinned(deviceId, from, to, pinned) {
            // Une seule instruction pour les deux tables : un instant à moitié
            // épinglé perd sa moitié à la purge suivante. Jointure extérieure :
            // la capture des processus est facultative. Le compte porte sur les
            // lignes concernées, pas modifiées : ré-épingler reste une action.
            const count = await pool.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM device_metrics WHERE device_id = ? AND ts BETWEEN ? AND ?',
                [deviceId, from, to]
            );
            const flag = pinned ? 1 : 0;
            await pool.query(
                `UPDATE device_metrics m
                 LEFT JOIN device_process_samples s ON s.device_id = m.device_id AND s.ts = m.ts
                 SET m.pinned = ?, s.pinned = ?
                 WHERE m.device_id = ? AND m.ts BETWEEN ? AND ?`,
                [flag, flag, deviceId, from, to]
            );
            return Number(count.rows[0]?.n ?? 0);
        }
    };
}
