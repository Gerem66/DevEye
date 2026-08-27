import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { UptimeCheckRow, UptimeIncidentRow, UptimeServiceRow } from '../contracts/domain';
import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import type { UptimeRepo } from './repo';
import { UptimeMonitor, type ProbeOutcome } from './service';

/**
 * L'ordonnanceur du module, sur le harnais de service du SDK.
 *
 * Aucun réseau : la sonde est injectée, et le test décide de ce qu'elle rend.
 * Ce qui mérite d'être tenu, c'est ce qui ne lève nulle part quand ça se
 * dérègle : le **seuil** (un échec isolé n'ouvre pas d'incident), la
 * **diffusion sur transition seulement** (`live.changed` à la bascule, jamais
 * à chaque tour), l'**exactly-once** des alertes (une par incident, adressée
 * à la route du SERVICE, avec sa mise en page Discord), et le rétablissement
 * qui ne s'annonce que si la panne l'avait été.
 */

interface FakeRepo extends UptimeRepo {
    rows: UptimeServiceRow[];
    checks: UptimeCheckRow[];
    incidents: UptimeIncidentRow[];
}

/**
 * Un dépôt en mémoire avec un service dû à chaque tour (`interval_seconds: 0`,
 * pour qu'un tick suive l'autre sans attendre) ; le harnais chiffre à
 * l'identité, donc le blob est le JSON en clair.
 */
function fakeRepo(over: Partial<UptimeServiceRow> = {}): FakeRepo {
    const rows: UptimeServiceRow[] = [
        {
            id: 1,
            user_id: 9,
            workspace_id: 1,
            content: JSON.stringify({ name: 'API OxyFoo', url: 'https://api.oxyfoo.com/health', keyword: null }),
            method: 'GET',
            expected_status: null,
            interval_seconds: 0,
            timeout_seconds: 10,
            failure_threshold: 2,
            retention_days: 30,
            enabled: 1,
            sort_order: 0,
            status: 'unknown',
            consecutive_failures: 0,
            last_checked_at: null,
            last_response_ms: null,
            last_http_status: null,
            last_error: null,
            created: 1,
            ...over
        }
    ];
    const checks: UptimeCheckRow[] = [];
    const incidents: UptimeIncidentRow[] = [];
    let incidentSeq = 0;
    const unused = async () => {
        throw new Error('non attendu ici');
    };
    return {
        rows,
        checks,
        incidents,
        services: {
            listByWorkspace: unused,
            listVisible: unused,
            findById: unused,
            findVisible: unused,
            create: unused,
            update: unused,
            setEnabled: unused,
            delete: unused,
            reorder: unused,
            // Des copies, comme une ligne lue en base : le moniteur compare
            // l'état d'AVANT la sonde à celui qu'il écrit, et une ligne mutée
            // sous lui ferait croire à un état inchangé.
            listDue: async (now, limit) =>
                rows
                    .filter(
                        (r) =>
                            r.enabled === 1 &&
                            (r.last_checked_at === null || r.last_checked_at + r.interval_seconds <= now)
                    )
                    .slice(0, limit)
                    .map((r) => ({ ...r })),
            recordProbe: async (id, result) => {
                const target = rows.find((r) => r.id === id);
                if (!target) return;
                target.status = result.status;
                target.consecutive_failures = result.consecutiveFailures;
                target.last_checked_at = result.checkedAt;
                target.last_response_ms = result.responseMs;
                target.last_http_status = result.httpStatus;
                target.last_error = result.error;
            },
            countByWorkspace: unused
        },
        history: {
            addCheck: async ({ serviceId, checkedAt, up, httpStatus, responseMs, error }) => {
                checks.push({
                    id: checks.length + 1,
                    service_id: serviceId,
                    checked_at: checkedAt,
                    up: up ? 1 : 0,
                    http_status: httpStatus,
                    response_ms: responseMs,
                    error
                });
            },
            listChecks: unused,
            checkStats: unused,
            rawPoints: unused,
            hourlyPoints: unused,
            dailyPoints: unused,
            windowStats: unused,
            dailyWindowStats: unused,
            openIncident: async (serviceId) =>
                incidents.find((i) => i.service_id === serviceId && i.ended_at === null) ?? null,
            listOpenIncidents: unused,
            openIncidentAt: async ({ serviceId, startedAt, httpStatus, error }) => {
                const incident: UptimeIncidentRow = {
                    id: ++incidentSeq,
                    service_id: serviceId,
                    started_at: startedAt,
                    ended_at: null,
                    http_status: httpStatus,
                    error,
                    notified: 0
                };
                incidents.push(incident);
                return incident;
            },
            markIncidentNotified: async (id) => {
                const incident = incidents.find((i) => i.id === id);
                if (incident) incident.notified = 1;
            },
            closeIncident: async (id, endedAt) => {
                const incident = incidents.find((i) => i.id === id && i.ended_at === null);
                if (incident) incident.ended_at = endedAt;
            },
            listIncidents: unused,
            pruneByRetention: async () => 0
        }
    };
}

const DOWN: ProbeOutcome = { up: false, httpStatus: 502, responseMs: 120, error: 'Statut HTTP 502 (attendu 2xx/3xx)' };
const UP: ProbeOutcome = { up: true, httpStatus: 200, responseMs: 80, error: null };

/** Le moniteur sur le harnais, avec une sonde pilotée par le test. */
function monitorWith(repo: FakeRepo, deps = createTestServiceDeps({ repo })) {
    let next: ProbeOutcome = UP;
    const monitor = new UptimeMonitor(deps, async () => next);
    return {
        deps,
        monitor,
        /** Un tour de la boucle des sondes, avec ce que la sonde doit rendre. */
        async probe(outcome: ProbeOutcome) {
            next = outcome;
            await deps.recorded.tickers[0].tick();
        }
    };
}

describe("la boucle et l'élagage", () => {
    it('pose deux tickers : les sondes toutes les dix secondes, l’élagage toutes les heures', () => {
        const { deps } = monitorWith(fakeRepo());
        assert.deepEqual(
            deps.recorded.tickers.map((t) => t.intervalMs),
            [10_000, 60 * 60 * 1000]
        );
    });
});

describe('une panne', () => {
    it("n'ouvre l'incident qu'au seuil, notifie une fois sur la route du service, et diffuse à la bascule seulement", async () => {
        const repo = fakeRepo();
        const { deps, probe } = monitorWith(repo);

        // Premier échec : un accroc, pas une panne. Le service garde son
        // état, rien ne part, personne n'est prévenu.
        await probe(DOWN);
        assert.equal(repo.checks.length, 1);
        assert.equal(repo.rows[0].status, 'unknown');
        assert.equal(repo.rows[0].consecutive_failures, 1);
        assert.deepEqual(deps.recorded.liveChanges, []);
        assert.equal(repo.incidents.length, 0);
        assert.equal(deps.recorded.notifications.length, 0);

        // Deuxième échec : le seuil est franchi. Bascule, incident, alerte.
        await probe(DOWN);
        assert.equal(repo.rows[0].status, 'down');
        assert.deepEqual(deps.recorded.liveChanges, [1]);
        assert.equal(repo.incidents.length, 1);
        assert.equal(repo.incidents[0].notified, 1);
        assert.equal(deps.recorded.notifications.length, 1);
        // Adressée à la route du SERVICE (la surcharge par élément), avec sa
        // mise en page Discord en plus du texte.
        assert.equal(deps.recorded.notifications[0].itemId, 1);
        assert.equal(deps.recorded.notifications[0].embeds, 1);
        assert.ok(deps.recorded.notifications[0].subject.includes('hors ligne'));
        assert.ok(deps.recorded.notifications[0].body.includes('502'));
        assert.equal(deps.recorded.audits[0].action, 'uptime.down');

        // Toujours en panne : même état, donc ni diffusion ni seconde alerte.
        await probe(DOWN);
        assert.deepEqual(deps.recorded.liveChanges, [1]);
        assert.equal(repo.incidents.length, 1);
        assert.equal(deps.recorded.notifications.length, 1);

        // Retour : l'incident se ferme, la bascule se diffuse, et le
        // rétablissement s'annonce parce que la panne l'avait été.
        await probe(UP);
        assert.equal(repo.rows[0].status, 'up');
        assert.deepEqual(deps.recorded.liveChanges, [1, 1]);
        assert.notEqual(repo.incidents[0].ended_at, null);
        assert.equal(deps.recorded.notifications.length, 2);
        assert.ok(deps.recorded.notifications[1].subject.includes('de retour'));
        assert.equal(deps.recorded.notifications[1].itemId, 1);
        assert.equal(deps.recorded.audits[1].action, 'uptime.recovered');
        assert.equal(repo.checks.length, 4);
    });

    it("ne signale pas un rétablissement dont la panne n'avait pas été notifiée", async () => {
        const repo = fakeRepo();
        // Une route sans canal : la façade rend `false` (le harnais enregistre
        // quand même la tentative), l'incident reste non-notifié, et un
        // « c'est revenu » sans « c'est tombé » n'existe pas.
        const deps = createTestServiceDeps({ repo, hasRoute: false, notifyAccepted: false });
        const { probe } = monitorWith(repo, deps);

        await probe(DOWN);
        await probe(DOWN);
        assert.equal(repo.incidents.length, 1);
        assert.equal(repo.incidents[0].notified, 0);
        assert.deepEqual(
            deps.recorded.notifications.map((n) => n.itemId),
            [1]
        );

        await probe(UP);
        assert.notEqual(repo.incidents[0].ended_at, null);
        // Rien de plus n'est parti : la tentative de la panne, et c'est tout.
        assert.equal(deps.recorded.notifications.length, 1);
    });
});
