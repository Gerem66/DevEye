import type { MetricRow, MetricSeriesPoint, MetricsResolution } from '@deveye/types';
import type { SdkQueryable } from '@deveye/types/sdk/server';

import type { DaySummary } from '../../contracts/commands';

/**
 * La table `device_metrics`, en lecture et en entretien : les fenêtres des
 * graphes, les instants de la frise, l'épinglage et les purges. L'insertion est
 * le fait de l'ingestion (`src/agent/ws.ts`), hors session.
 */
export interface MetricRepo {
    query(input: {
        deviceId: string;
        from: number;
        to: number;
        resolution: MetricsResolution;
    }): Promise<MetricSeriesPoint[]>;
    /**
     * Les jours locaux qui portent des instants, croissants, avec leur compte
     * total et leur compte d'épingles. Bucketisés dans le fuseau du client
     * (`tzOffsetMinutes` = `Date.getTimezoneOffset()`).
     */
    availableDaySummaries(deviceId: string, tzOffsetMinutes: number): Promise<DaySummary[]>;
    /**
     * Timestamps of the stored instants within [from, to], ascending, plus the
     * pinned subset: the timeline's marks. Keyed on the metric rows, not the
     * optional process samples.
     */
    instantTimes(
        deviceId: string,
        from: number,
        to: number
    ): Promise<{ timestamps: number[]; pinned: number[]; truncated: boolean }>;
    /**
     * Épingle (ou désépingle) les **instants** de [from, to] : la ligne métrique
     * et, quand elle existe, la liste de processus du même horodatage. Rend le
     * nombre d'instants concernés.
     */
    setInstantsPinned(deviceId: string, from: number, to: number, pinned: boolean): Promise<number>;
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
    hour: 3600
};

/**
 * Plafonds de lecture. Un relevé toutes les 5 s produit 17 280 instants par
 * jour : les marques de la frise doivent couvrir une journée entière. Les
 * points de graphe sont déjà réduits par la résolution : leur plafond n'est
 * qu'un garde-fou. Dans les deux cas la sélection prend les plus récents.
 */
const MAX_INSTANT_MARKS = 20_000;
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

function rowToPoint(r: MetricRow): MetricSeriesPoint {
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

export function metricRepo(q: SdkQueryable): MetricRepo {
    return {
        async query({ deviceId, from, to, resolution }) {
            if (resolution === 'raw') {
                // Les plus récents, puis remis dans l'ordre : au-delà du plafond,
                // c'est le début de la fenêtre qui manque, pas sa fin.
                const rows = await q.query<MetricRow>(
                    `SELECT * FROM device_metrics
                     WHERE device_id = ? AND ts BETWEEN ? AND ?
                     ORDER BY ts DESC
                     LIMIT ${MAX_SERIES_POINTS}`,
                    [deviceId, from, to]
                );
                return rows.reverse().map(rowToPoint);
            }

            // Averages for gauges, max for counters. Le SELECT et le GROUP BY
            // portent la même expression (sinon `only_full_group_by`).
            const bucketMs = BUCKET_SECONDS[resolution] * 1000;
            const rows = await q.query<MetricRow>(
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
            return rows.reverse().map(rowToPoint);
        },
        async availableDaySummaries(deviceId, tzOffsetMinutes) {
            // Bucket by local day in pure integer math, independent of the
            // session timezone: local-ms = ts - offset*60000.
            const offsetMs = tzOffsetMinutes * 60000;
            const dayMs = 86400000;
            // Sans borne temporelle : un plancher à la rétention ferait
            // disparaître du calendrier les journées ne contenant plus que des
            // instants épinglés. Deux requêtes plutôt qu'un SUM(pinned) : chacune
            // est couverte par un index (`uq_metrics_device_ts` puis
            // `idx_metrics_device_pinned_ts`), là où l'agrégat forcerait une
            // lecture de ligne par instant.
            const [totals, pins] = await Promise.all([
                q.query<{ d: number; n: number }>(
                    `SELECT FLOOR((ts - ?) / ?) AS d, COUNT(*) AS n
                     FROM device_metrics WHERE device_id = ?
                     GROUP BY d ORDER BY d ASC`,
                    [offsetMs, dayMs, deviceId]
                ),
                q.query<{ d: number; n: number }>(
                    `SELECT FLOOR((ts - ?) / ?) AS d, COUNT(*) AS n
                     FROM device_metrics WHERE device_id = ? AND pinned = 1
                     GROUP BY d ORDER BY d ASC`,
                    [offsetMs, dayMs, deviceId]
                )
            ]);
            const pinnedByDay = new Map<number, number>();
            for (const row of pins) pinnedByDay.set(Number(row.d), Number(row.n));
            // index*dayMs is local midnight as a UTC instant: formatting it as
            // UTC yields the local calendar day.
            return totals.map((row) => {
                const d = Number(row.d);
                return {
                    day: new Date(d * dayMs).toISOString().slice(0, 10),
                    instants: Number(row.n),
                    pinned: pinnedByDay.get(d) ?? 0
                };
            });
        },
        async instantTimes(deviceId, from, to) {
            // Same shape and bound as `processSamples.snapshotTimes`.
            const rows = await q.query<{ ts: number; pinned: number }>(
                `SELECT ts, pinned FROM device_metrics
                 WHERE device_id = ? AND ts BETWEEN ? AND ?
                 ORDER BY ts DESC
                 LIMIT ${MAX_INSTANT_MARKS + 1}`,
                [deviceId, from, to]
            );
            // Une ligne de plus que le plafond : si elle existe, la fenêtre en
            // contenait davantage, et on le dit.
            const truncated = rows.length > MAX_INSTANT_MARKS;
            const kept = truncated ? rows.slice(0, MAX_INSTANT_MARKS) : rows;
            const timestamps: number[] = [];
            const pinned: number[] = [];
            for (const row of kept.reverse()) {
                const ts = Number(row.ts);
                timestamps.push(ts);
                if (Number(row.pinned) === 1) pinned.push(ts);
            }
            return { timestamps, pinned, truncated };
        },
        async setInstantsPinned(deviceId, from, to, pinned) {
            // Les deux tables en une seule instruction : un instant à moitié
            // épinglé perd sa moitié à la purge suivante. Jointure extérieure :
            // la capture des processus est facultative. Le compte porte sur les
            // lignes concernées et non modifiées : ré-épingler reste une action.
            const count = await q.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM device_metrics WHERE device_id = ? AND ts BETWEEN ? AND ?',
                [deviceId, from, to]
            );
            const flag = pinned ? 1 : 0;
            await q.execute(
                `UPDATE device_metrics m
                 LEFT JOIN device_process_samples s ON s.device_id = m.device_id AND s.ts = m.ts
                 SET m.pinned = ?, s.pinned = ?
                 WHERE m.device_id = ? AND m.ts BETWEEN ? AND ?`,
                [flag, flag, deviceId, from, to]
            );
            return Number(count[0]?.n ?? 0);
        },
        async deleteExpiredInRange(deviceId, from, to, defaultDays) {
            const r = await q.execute(
                `DELETE m FROM device_metrics m
                 JOIN devices d ON d.id = m.device_id
                 WHERE m.device_id = ? AND m.ts BETWEEN ? AND ?
                   AND m.pinned = 0 AND d.status <> 'archived'
                   AND m.ts < (UNIX_TIMESTAMP() * 1000) - COALESCE(d.retention_days, ?) * 86400000`,
                [deviceId, from, to, defaultDays]
            );
            return r.affectedRows;
        },
        async pruneByRetention(defaultDays) {
            const r = await q.execute(
                `DELETE m FROM device_metrics m
                 JOIN devices d ON d.id = m.device_id
                 WHERE m.pinned = 0
                   AND d.status <> 'archived'
                   AND m.ts < (UNIX_TIMESTAMP() * 1000) - COALESCE(d.retention_days, ?) * 86400000`,
                [defaultDays]
            );
            return r.affectedRows;
        }
    };
}
