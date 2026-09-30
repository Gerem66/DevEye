import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MetricSnapshot } from '@deveye/types';

import { fakeQueryable } from '../pool.fake';
import { metricsRepo } from './metrics';

/**
 * Les métriques d'un appareil : ce que MySQL rend (des chaînes pour les grands
 * entiers, des décimales pour une moyenne) redevient ce que le schéma de sortie
 * exige, une fenêtre trop large perd son début et non sa fin, et un lot rejoué
 * ne désépingle rien.
 */

const ROW = {
    id: 1,
    device_id: 'd',
    ts: '1700000000000',
    cpu_percent: '12.5',
    mem_used_bytes: 1234.6,
    mem_total_bytes: 4096,
    disk_used_bytes: 10,
    disk_total_bytes: 20,
    net_rx_bytes: 1,
    net_tx_bytes: 2,
    users_count: 1,
    load_avg_1: null,
    cpu_temp_c: '41.2',
    uptime_seconds: 99.4,
    process_count: null,
    active_connections: null,
    gpu_percent: null,
    disk_read_bytes: null,
    disk_write_bytes: null,
    battery_percent: null,
    battery_charging: 1,
    pinned: 0
};

const SNAPSHOT: MetricSnapshot = {
    timestamp: 1700000000000,
    cpuPercent: 1,
    memUsedBytes: 1,
    memTotalBytes: 2,
    diskUsedBytes: 1,
    diskTotalBytes: 2,
    netRxBytes: 0,
    netTxBytes: 0,
    usersCount: 1,
    loadAvg1: null,
    cpuTempC: null,
    uptimeSeconds: null,
    processCount: null,
    activeConnections: null,
    gpuPercent: null,
    diskReadBytes: null,
    diskWriteBytes: null,
    batteryPercent: null,
    batteryCharging: null,
    processes: [],
    processKind: null
};

describe('la lecture des métriques', () => {
    it('convertit chaque colonne vers le point de série, entiers arrondis et drapeau en booléen', async () => {
        const point = await metricsRepo(fakeQueryable(() => [ROW])).latest('d');
        assert.equal(point?.timestamp, 1700000000000);
        assert.equal(point?.cpuPercent, 12.5);
        assert.equal(point?.memUsedBytes, 1235);
        assert.equal(point?.uptimeSeconds, 99);
        assert.equal(point?.cpuTempC, 41.2);
        assert.equal(point?.loadAvg1, null);
        assert.equal(point?.batteryCharging, true);
    });

    it('laisse null un drapeau de charge inconnu', async () => {
        const point = await metricsRepo(fakeQueryable(() => [{ ...ROW, battery_charging: null }])).latest('d');
        assert.equal(point?.batteryCharging, null);
    });

    it('prend les plus récents sous un plafond, puis les rend dans l’ordre du temps', async () => {
        const q = fakeQueryable(() => [3, 2, 1].map((ts) => ({ ...ROW, ts })));
        const points = await metricsRepo(q).query({ deviceId: 'd', from: 0, to: 10, resolution: 'raw' });
        assert.match(q.queries[0]!.sql, /ORDER BY ts DESC\s+LIMIT 5000$/);
        assert.deepEqual(
            points.map((p) => p.timestamp),
            [1, 2, 3]
        );
    });

    it('agrège par seau quand la résolution le demande, le seau lié en millisecondes', async () => {
        const q = fakeQueryable(() => []);
        await metricsRepo(q).query({ deviceId: 'd', from: 0, to: 10, resolution: 'minute' });
        assert.match(q.queries[0]!.sql, /GROUP BY/);
        assert.deepEqual(q.queries[0]!.params, [60000, 60000, 'd', 0, 10, 60000, 60000]);
    });
});

describe('l’ingestion des métriques', () => {
    it('n’émet rien pour un lot vide', async () => {
        const q = fakeQueryable();
        await metricsRepo(q).insertBatch('d', []);
        assert.equal(q.queries.length, 0);
    });

    it('écrit tout le lot en une requête, sans jamais toucher à l’épingle', async () => {
        const q = fakeQueryable();
        await metricsRepo(q).insertBatch('d', [SNAPSHOT, { ...SNAPSHOT, timestamp: 1700000001000 }]);
        assert.equal(q.queries.length, 1);
        const { sql, params } = q.queries[0]!;
        assert.equal((sql.match(/\(\?(, \?){19}\)/g) ?? []).length, 2);
        assert.equal(params.length, 40);
        assert.doesNotMatch(sql.slice(sql.indexOf('ON DUPLICATE KEY UPDATE')), /pinned/);
    });

    it('épingle les deux tables d’un coup et compte les instants visés, pas les lignes modifiées', async () => {
        const q = fakeQueryable((sql) => (sql.startsWith('SELECT') ? [{ n: '3' }] : { rowCount: 0 }));
        const touched = await metricsRepo(q).setInstantsPinned('d', 0, 10, true);
        assert.equal(touched, 3);
        assert.match(q.queries[1]!.sql, /LEFT JOIN device_process_samples/);
        assert.deepEqual(q.queries[1]!.params, [1, 1, 'd', 0, 10]);
    });
});
