import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { UptimeDayRow, UptimeIncidentRow, UptimeServiceRow } from '../../contracts/domain';
import { buildStatusView, DAY, type StatusViewInput } from './view';

/**
 * Ce que la page publique dit, calculé des lignes : le verdict de chaque jour,
 * le bandeau, les pannes en cours et l'historique, et la nature d'une panne
 * réduite à une catégorie.
 */

const NOW = 1_790_000_000;
const TODAY = Math.floor(NOW / DAY) * DAY;

function service(id: number, over: Partial<UptimeServiceRow> = {}): UptimeServiceRow {
    return {
        id,
        user_id: 1,
        workspace_id: 1,
        content: '',
        method: 'GET',
        baseline_enc: null,
        integrity_interval_seconds: null,
        integrity_checked_at: null,
        integrity_failures: 0,
        integrity_verdict: null,
        integrity_pending_since: null,
        deploy_hook_hash: null,
        deploy_hook_enc: null,
        deploy_hook_at: null,
        expected_status: null,
        interval_seconds: 60,
        timeout_seconds: 10,
        failure_threshold: 2,
        retention_days: null,
        enabled: 1,
        sort_order: id,
        status: 'up',
        consecutive_failures: 0,
        last_checked_at: NOW,
        last_response_ms: 120,
        last_http_status: 200,
        last_error: null,
        created: 1,
        ...over
    };
}

function day(serviceId: number, daysAgo: number, checks: number, upChecks: number): UptimeDayRow {
    return {
        service_id: serviceId,
        day: TODAY - daysAgo * DAY,
        checks,
        up_checks: upChecks,
        total_ms: checks * 100,
        ms_samples: checks,
        min_ms: 80,
        max_ms: 150
    };
}

function incident(
    serviceId: number,
    startedAt: number,
    endedAt: number | null,
    httpStatus: number | null = 502
): UptimeIncidentRow {
    return {
        id: startedAt,
        service_id: serviceId,
        started_at: startedAt,
        ended_at: endedAt,
        http_status: httpStatus,
        error: null,
        notified: 1
    };
}

function input(over: Partial<StatusViewInput> = {}): StatusViewInput {
    return {
        now: NOW,
        title: 'Nos services',
        description: '',
        theme: 'auto',
        showErrors: false,
        showLatency: false,
        services: [{ row: service(1), name: 'API' }],
        daily: [],
        incidents: [],
        latency: [],
        ...over
    };
}

describe('les barres', () => {
    it('donne son verdict à chaque jour des 90 : panne, perturbations, bon, sans mesure', async () => {
        const view = buildStatusView(
            input({
                daily: [day(1, 0, 100, 100), day(1, 1, 100, 97), day(1, 2, 100, 90)],
                incidents: [{ row: incident(1, TODAY - 2 * DAY + 3600, TODAY - 2 * DAY + 3600 + 720), error: null }]
            })
        );
        const bars = view.services[0].bars;
        assert.equal(bars.length, 90);
        assert.equal(bars[89].day, TODAY);
        assert.equal(bars[89].tone, 'up');
        assert.equal(bars[88].tone, 'degraded');
        assert.equal(bars[87].tone, 'down');
        assert.equal(bars[87].downSeconds, 720);
        assert.equal(bars[0].tone, 'empty');
        assert.equal(bars[0].ratio, null);
    });

    it('fait courir une panne en cours jusqu’à maintenant, sur chaque jour qu’elle touche', async () => {
        const view = buildStatusView(
            input({
                services: [{ row: service(1, { status: 'down' }), name: 'API' }],
                incidents: [{ row: incident(1, TODAY - DAY + 3600, null), error: null }]
            })
        );
        const bars = view.services[0].bars;
        assert.equal(bars[88].downSeconds, DAY - 3600);
        assert.equal(bars[89].downSeconds, NOW - TODAY);
        assert.equal(view.ongoing.length, 1);
        assert.equal(view.ongoing[0].service, 'API');
    });

    it('calcule la disponibilité sur la fenêtre entière', async () => {
        const view = buildStatusView(input({ daily: [day(1, 0, 100, 100), day(1, 1, 100, 98)] }));
        assert.equal(view.services[0].ratio, 0.99);
    });
});

describe('le bandeau', () => {
    it('compte les services en panne parmi ceux qu’on surveille, sans ceux en pause', async () => {
        const view = buildStatusView(
            input({
                services: [
                    { row: service(1, { status: 'down' }), name: 'API' },
                    { row: service(2), name: 'Site' },
                    { row: service(3, { enabled: 0 }), name: 'Ancien' }
                ]
            })
        );
        assert.deepEqual(view.banner, { tone: 'down', down: 1, watched: 2 });
        assert.equal(view.services[2].state, 'paused');
    });

    it('tient pour en pause un service que l’offre de son propriétaire met en pause', async () => {
        const view = buildStatusView(
            input({
                services: [
                    { row: service(1, { status: 'down' }), name: 'API', planPaused: true },
                    { row: service(2), name: 'Site' }
                ]
            })
        );
        assert.equal(view.services[0].state, 'paused');
        assert.deepEqual(view.banner, { tone: 'up', down: 0, watched: 1 });
    });

    it('attend la première mesure, et se dit suspendu quand tout est en pause', async () => {
        assert.equal(
            buildStatusView(input({ services: [{ row: service(1, { status: 'unknown' }), name: 'API' }] })).banner.tone,
            'pending'
        );
        assert.equal(
            buildStatusView(input({ services: [{ row: service(1, { enabled: 0 }), name: 'API' }] })).banner.tone,
            'paused'
        );
        assert.equal(buildStatusView(input()).banner.tone, 'up');
    });
});

describe('les pannes', () => {
    it('garde l’historique d’un mois, le plus récent d’abord', async () => {
        const view = buildStatusView(
            input({
                incidents: [
                    { row: incident(1, NOW - 40 * DAY, NOW - 40 * DAY + 60), error: null },
                    { row: incident(1, NOW - 3 * DAY, NOW - 3 * DAY + 600), error: null },
                    { row: incident(1, NOW - DAY, NOW - DAY + 60), error: null }
                ]
            })
        );
        assert.deepEqual(
            view.history.map((i) => i.startedAt),
            [NOW - DAY, NOW - 3 * DAY]
        );
        assert.ok(view.history.every((i) => i.reason === null));
    });

    it('ne dit d’une panne que sa catégorie, jamais le message de la sonde', async () => {
        const view = buildStatusView(
            input({
                showErrors: true,
                incidents: [
                    { row: incident(1, NOW - 4000, NOW - 3000, null), error: 'connect ECONNREFUSED 10.0.0.5:443' },
                    { row: incident(1, NOW - 6000, NOW - 5000, null), error: 'Délai dépassé (10 s)' },
                    {
                        row: incident(1, NOW - 8000, NOW - 7000, 200),
                        error: 'Mot-clé « jeton-interne » absent de la réponse'
                    },
                    { row: incident(1, NOW - 9000, NOW - 8500, 503), error: 'Statut HTTP 503 (attendu 2xx/3xx)' },
                    // La page répond 200 : c'est le fichier qui dit la panne.
                    {
                        row: incident(1, NOW - 10_000, NOW - 9500, 200),
                        error: 'Intégrité : 1 fichier modifié\nModifié : /assets/app.js'
                    },
                    {
                        row: incident(1, NOW - 11_000, NOW - 10_500, 200),
                        error: 'Fichiers : Statut HTTP 404 sur /assets/app.js'
                    }
                ]
            })
        );
        assert.deepEqual(
            view.history.map((i) => i.reason),
            [
                'Connexion impossible',
                'Délai de réponse dépassé',
                'Contenu inattendu',
                'Réponse HTTP 503',
                'Intégrité des fichiers compromise',
                'Fichiers du site indisponibles'
            ]
        );
    });
});

describe('le temps de réponse', () => {
    it('tient 24 heures, une moyenne par heure et la moyenne pondérée du tout', async () => {
        const hour = Math.floor(NOW / 3600) * 3600;
        const view = buildStatusView(
            input({
                showLatency: true,
                latency: [
                    { service_id: 1, at: hour, total_ms: 300, samples: 3 },
                    { service_id: 1, at: hour - 3600, total_ms: 200, samples: 1 }
                ]
            })
        );
        const latency = view.services[0].latency;
        assert.ok(latency);
        assert.equal(latency.points.length, 24);
        assert.equal(latency.points[23], 100);
        assert.equal(latency.points[22], 200);
        assert.equal(latency.points[0], null);
        assert.equal(latency.avgMs, 125);
        assert.equal(buildStatusView(input()).services[0].latency, null);
    });
});
