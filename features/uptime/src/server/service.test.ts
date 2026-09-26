import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { UptimeCheckRow, UptimeIncidentRow, UptimeServiceRow } from '../contracts/domain';
import { UPTIME_ITEMS_PROVIDER, type UptimeItemsProvider } from '@deveye/types/sdk';
import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import { serverEntry } from './index';
import type { UptimeRepo } from './repo';
import type { UptimePagesRepo, UptimeStatusRepo } from './repoPages';
import { UptimeMonitor, type ProbeOutcome } from './service';

/**
 * Aucun réseau : la sonde est injectée. Ce qui se vérifie ne lève nulle part
 * quand ça se dérègle : le seuil, la diffusion sur transition seulement,
 * l'exactly-once des alertes (une par incident, sur la route du service) et le
 * rétablissement qui ne s'annonce que si la panne l'avait été.
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
            kind: 'http',
            method: 'GET',
            baseline_enc: null,
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
            countInWorkspaces: unused,
            listStock: unused,
            listVisible: unused,
            findById: async (id, workspaceId) =>
                rows.find((r) => r.id === id && r.workspace_id === workspaceId) ?? null,
            findVisible: async (id, workspaceId) =>
                rows.find((r) => r.id === id && r.workspace_id === workspaceId) ?? null,
            create: unused,
            update: unused,
            setEnabled: unused,
            delete: unused,
            reorder: unused,
            // Des copies, comme une ligne lue en base : le moniteur compare
            // l'état d'AVANT la sonde à celui qu'il écrit, et une ligne mutée
            // sous lui ferait croire à un état inchangé.
            // Les pauses d'offre s'écartent avant la coupe, comme dans la requête.
            listDue: async (now, limit, planPaused) =>
                rows
                    .filter(
                        (r) =>
                            r.enabled === 1 &&
                            !planPaused.includes(r.id) &&
                            (r.last_checked_at === null || r.last_checked_at + r.interval_seconds <= now)
                    )
                    .slice(0, limit)
                    .map((r) => ({ ...r })),
            setBaseline: async (id, baselineEnc) => {
                const r = rows.find((x) => x.id === id);
                if (r) r.baseline_enc = baselineEnc;
            },
            recordProbe: async (id, result) => {
                const target = rows.find((r) => r.id === id);
                if (!target) return;
                target.status = result.status;
                target.consecutive_failures = result.consecutiveFailures;
                target.last_checked_at = result.checkedAt;
                target.last_response_ms = result.responseMs;
                target.last_http_status = result.httpStatus;
                target.last_error = result.error;
            }
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
        },
        // Les pages de statut ont leurs propres tests (`pages.test.ts`).
        pages: {} as UptimePagesRepo,
        status: {} as UptimeStatusRepo
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

describe('un contrôle d’intégrité', () => {
    const CAPTURE = {
        csp: "script-src 'self'",
        files: { '/': 'h-index', '/assets/app.js': 'h-app' },
        source: 'page' as const,
        documentStatus: 200
    };
    const LEARNED: ProbeOutcome = { up: true, httpStatus: 200, responseMs: 300, error: null, capture: CAPTURE };
    const DRIFT: ProbeOutcome = {
        up: false,
        httpStatus: 200,
        responseMs: 300,
        error: 'Intégrité : 1 fichier modifié',
        driftLines: ['Modifié : /assets/app.js']
    };

    it('apprend sa référence à la première lecture, puis la tend à la sonde', async () => {
        const repo = fakeRepo({ kind: 'integrity', failure_threshold: 1 });
        const deps = createTestServiceDeps({ repo });
        const seen: (string | null)[] = [];
        const monitor = new UptimeMonitor(deps, async (_target, _row, baseline) => {
            seen.push(baseline ? Object.keys(baseline.files).join(',') : null);
            return LEARNED;
        });
        await deps.recorded.tickers[0].tick();
        assert.equal(repo.rows[0].status, 'up');
        assert.ok(repo.rows[0].baseline_enc);
        const stored = JSON.parse(repo.rows[0].baseline_enc!) as { files: Record<string, string>; csp: string };
        assert.deepEqual(stored.files, CAPTURE.files);
        assert.equal(stored.csp, CAPTURE.csp);
        // Le tour suivant reçoit la référence apprise.
        await monitor.runOne(repo.rows[0]);
        assert.deepEqual(seen, [null, '/,/assets/app.js']);
        assert.equal(deps.recorded.notifications.length, 0);
    });

    it('un écart ouvre un incident détaillé et une alerte d’intégrité, l’acceptation le referme', async () => {
        const repo = fakeRepo({
            kind: 'integrity',
            failure_threshold: 1,
            baseline_enc: JSON.stringify({ capturedAt: 1, csp: CAPTURE.csp, files: CAPTURE.files, source: 'page' })
        });
        const { deps, probe } = monitorWith(repo);

        await probe(DRIFT);
        assert.equal(repo.rows[0].status, 'down');
        assert.equal(repo.incidents.length, 1);
        // Le résumé sur la ligne du service, le détail fichier par fichier sur l'incident.
        assert.equal(repo.rows[0].last_error, 'Intégrité : 1 fichier modifié');
        assert.equal(repo.incidents[0].error, 'Intégrité : 1 fichier modifié\nModifié : /assets/app.js');
        assert.equal(deps.recorded.notifications.length, 1);
        assert.ok(deps.recorded.notifications[0].subject.includes('fichiers modifiés'));
        assert.ok(deps.recorded.notifications[0].body.includes('Modifié : /assets/app.js'));
        assert.equal(deps.recorded.audits[0].action, 'uptime.integrity');

        // Accepter : la référence est oubliée, la lecture suivante apprend et
        // referme l'incident par le chemin ordinaire, « rétabli » compris.
        repo.rows[0].baseline_enc = null;
        await probe(LEARNED);
        assert.equal(repo.rows[0].status, 'up');
        assert.notEqual(repo.incidents[0].ended_at, null);
        assert.ok(repo.rows[0].baseline_enc);
        assert.equal(deps.recorded.notifications.length, 2);
        assert.ok(deps.recorded.notifications[1].subject.includes('de retour'));
    });
});

describe('la pause de l’offre', () => {
    it('n’est ni relevée ni sondée, et reprend d’elle-même quand l’offre la lève', async () => {
        const repo = fakeRepo();
        const paused = ['1'];
        const asked: (readonly number[])[] = [];
        const listDue = repo.services.listDue;
        repo.services.listDue = (now, limit, planPaused) => {
            asked.push(planPaused);
            return listDue(now, limit, planPaused);
        };
        const { probe } = monitorWith(repo, createTestServiceDeps({ repo, pausedItems: { monitors: paused } }));

        await probe(DOWN);
        assert.deepEqual(asked, [[1]]);
        assert.equal(repo.checks.length, 0);
        // Le choix de l'utilisateur n'a pas bougé : c'est lui qui reprend.
        assert.equal(repo.rows[0].enabled, 1);

        paused.length = 0;
        await probe(DOWN);
        assert.deepEqual(asked[1], []);
        assert.equal(repo.checks.length, 1);
    });

    it('ne sonde pas un service en pause qu’on lui tend directement', async () => {
        const repo = fakeRepo();
        const deps = createTestServiceDeps({ repo, pausedItems: { monitors: ['1'] } });
        await new UptimeMonitor(deps, async () => UP).runOne({ ...repo.rows[0] });
        assert.equal(repo.checks.length, 0);
    });

    it('ferme la panne en cours d’un service qu’elle vient de mettre en pause', async () => {
        const repo = fakeRepo();
        const { deps, probe } = monitorWith(repo);
        await probe(DOWN);
        await probe(DOWN);
        assert.equal(repo.incidents[0].ended_at, null);

        const service = serverEntry.createService?.(deps);
        assert.ok(service?.onPlanPause);
        await service.onPlanPause({ key: 'pages', paused: [{ id: '1', workspaceId: 1 }], resumed: [] });
        assert.equal(repo.incidents[0].ended_at, null, 'une page du même identifiant n’est pas ce service');
        await service.onPlanPause({ key: 'monitors', paused: [{ id: '1', workspaceId: 1 }], resumed: [] });
        assert.notEqual(repo.incidents[0].ended_at, null);
    });
});

/** Le contrat offert à Projets, tel que `createService` le publie au boot. */
function itemsProviderOn(repo: FakeRepo): UptimeItemsProvider {
    const service = serverEntry.createService?.(createTestServiceDeps({ repo }));
    assert.ok(service, 'le module crée un service');
    const provider = service.providers?.[UPTIME_ITEMS_PROVIDER] as UptimeItemsProvider | undefined;
    assert.ok(provider, 'le service publie le contrat des éléments');
    return provider;
}

describe('UPTIME_ITEMS_PROVIDER : labelOf', () => {
    it("rend le nom déchiffré d'un service vivant, null pour un identifiant inconnu ou un autre espace", async () => {
        const provider = itemsProviderOn(fakeRepo());
        assert.equal(await provider.labelOf(1, 1), 'API OxyFoo');
        assert.equal(await provider.labelOf(42, 1), null);
        assert.equal(await provider.labelOf(1, 2), null);
    });
});
