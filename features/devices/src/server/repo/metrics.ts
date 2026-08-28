import type { MetricRow, MetricSeriesPoint, MetricsResolution } from '@deveye/types';
import type { SdkQueryable } from '@deveye/types/sdk/server';

/**
 * La table `device_metrics`, en lecture et en entretien : les fenêtres que
 * les graphes relisent, les instants de la frise, l'épinglage et les purges.
 * L'insertion d'un lot est le fait de l'ingestion (`src/agent/ws.ts`, dépôt du
 * socle), hors session ; la façade `telemetry` de l'app lit la même table
 * pour Sentinelle.
 */
export interface MetricRepo {
    query(input: {
        deviceId: string;
        from: number;
        to: number;
        resolution: MetricsResolution;
    }): Promise<MetricSeriesPoint[]>;
    /**
     * Distinct local days (YYYY-MM-DD) that have samples, ascending, bucketed in
     * the client's timezone (`tzOffsetMinutes` = `Date.getTimezoneOffset()`).
     */
    availableDays(deviceId: string, tzOffsetMinutes: number): Promise<string[]>;
    /**
     * Timestamps of the stored instants within [from, to], ascending, split into
     * all vs the pinned subset: the timeline's marks. Keyed on the metric rows
     * (one per collection tick) rather than on the process samples, which are
     * optional: a device with `processCapture: 'off'` still has instants to
     * navigate.
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
 * Plafonds de lecture, et pourquoi ils diffèrent.
 *
 * Un relevé toutes les 5 s (la cadence la plus rapide configurable) produit
 * 17 280 instants par jour. Les marques de la frise doivent donc pouvoir
 * couvrir une journée entière, sinon la navigation par ‹ › s'arrête au milieu
 * sans le dire. Les points de graphe, eux, sont déjà réduits par la résolution
 * choisie selon la largeur de fenêtre : leur plafond n'est qu'un garde-fou.
 *
 * Dans les deux cas la sélection prend les plus **récents** : tronquer par le
 * début rendait la queue de la fenêtre, celle qu'on regarde, invisible.
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
                // Les plus récents, puis remis dans l'ordre : au-delà du
                // plafond, c'est le début de la fenêtre qui doit manquer, pas
                // sa fin.
                const rows = await q.query<MetricRow>(
                    `SELECT * FROM device_metrics
                     WHERE device_id = ? AND ts BETWEEN ? AND ?
                     ORDER BY ts DESC
                     LIMIT ${MAX_SERIES_POINTS}`,
                    [deviceId, from, to]
                );
                return rows.reverse().map(rowToPoint);
            }

            // Downsample by time bucket (averages for gauges, max for counters).
            // Le SELECT bucketisé et le GROUP BY portent la même expression
            // (sinon `only_full_group_by`).
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
        async availableDays(deviceId, tzOffsetMinutes) {
            // Bucket by *local* day using pure integer math so the result is
            // independent of the MySQL/Node session timezone. `getTimezoneOffset`
            // is (UTC - local) in minutes, so local-ms = ts - offset*60000.
            const offsetMs = tzOffsetMinutes * 60000;
            const dayMs = 86400000;
            // Volontairement sans borne temporelle. Un plancher à la rétention
            // ferait disparaître du calendrier les journées ne contenant plus
            // que des instants **épinglés**, dont tout l'objet est justement de
            // survivre à la rétention : la navigation ne pourrait plus les
            // atteindre. Le coût reste un parcours d'index seul sur
            // `uq_metrics_device_ts`, borné à un appareil.
            const rows = await q.query<{ d: number }>(
                `SELECT DISTINCT FLOOR((ts - ?) / ?) AS d
                 FROM device_metrics WHERE device_id = ?
                 ORDER BY d ASC`,
                [offsetMs, dayMs, deviceId]
            );
            // Day index → 'YYYY-MM-DD': index*dayMs is local midnight expressed as
            // a UTC instant, so formatting it as UTC yields the local calendar day.
            return rows.map((row) => new Date(Number(row.d) * dayMs).toISOString().slice(0, 10));
        },
        async instantTimes(deviceId, from, to) {
            // Same shape and bound as `processSamples.snapshotTimes`, so the two
            // sources merge without either side having to handle a different cap.
            const rows = await q.query<{ ts: number; pinned: number }>(
                `SELECT ts, pinned FROM device_metrics
                 WHERE device_id = ? AND ts BETWEEN ? AND ?
                 ORDER BY ts DESC
                 LIMIT ${MAX_INSTANT_MARKS + 1}`,
                [deviceId, from, to]
            );
            // Une ligne de plus que le plafond a été demandée : si elle existe,
            // la fenêtre en contenait davantage, et on le dit au lieu de rendre
            // une frise silencieusement amputée.
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
            // Les deux tables en **une seule instruction**, et non deux requêtes
            // parallèles : un instant à moitié épinglé est un instant dont la
            // moitié disparaît à la purge suivante, et rien ne rattraperait
            // l'échec d'une des deux moitiés. La jointure est extérieure parce
            // que la capture des processus est facultative : un appareil en
            // `processCapture: 'off'` a des instants sans liste, et ils doivent
            // s'épingler quand même.
            //
            // Le compte porte sur les lignes *concernées* et non modifiées :
            // ré-épingler un intervalle déjà épinglé reste une action, et
            // l'appelant s'en sert pour son journal.
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
