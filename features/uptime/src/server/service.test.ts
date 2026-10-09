import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
    UptimeCheckRow,
    UptimeDeploySourceRow,
    UptimeIncidentRow,
    UptimeIntegrityReadingRow,
    UptimeServiceRow
} from '../contracts/domain';
import {
    DEPLOY_ITEMS_PROVIDER,
    UPTIME_ITEMS_PROVIDER,
    type DeployActivity,
    type DeployItemsProvider,
    type UptimeItemsProvider
} from '@deveye/types/sdk';
import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import { serverEntry } from './index';
import type { UptimeRepo } from './repo';
import type { UptimePagesRepo, UptimeStatusRepo } from './repoPages';
import { integrityDue, UptimeMonitor, type IntegrityReading, type ProbeOutcome } from './service';

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
    readings: UptimeIntegrityReadingRow[];
    sources: UptimeDeploySourceRow[];
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
    const readings: UptimeIntegrityReadingRow[] = [];
    const sources: UptimeDeploySourceRow[] = [];
    let incidentSeq = 0;
    const unused = async () => {
        throw new Error('non attendu ici');
    };
    return {
        rows,
        checks,
        incidents,
        readings,
        sources,
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
            setIntegrity: unused,
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
            recordIntegrity: async (id, reading) => {
                const r = rows.find((x) => x.id === id);
                if (!r) return;
                r.integrity_checked_at = reading.checkedAt;
                r.integrity_failures = reading.failures;
                r.integrity_verdict = reading.verdict;
                r.baseline_enc = reading.baseline ?? r.baseline_enc;
                r.integrity_pending_since = reading.pendingSince;
            },
            resetIntegrity: async (id) => {
                const r = rows.find((x) => x.id === id);
                if (!r) return;
                r.baseline_enc = null;
                r.integrity_checked_at = null;
                r.integrity_failures = 0;
                r.integrity_verdict = null;
                r.integrity_pending_since = null;
            },
            listDeploySources: async (ids) => sources.filter((x) => ids.includes(x.service_id)),
            setDeploySources: unused,
            setDeployHook: unused,
            findByDeployHook: unused,
            markDeployHookCalled: unused,
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
            addReading: async ({ serviceId, checkedAt, outcome, fileCount, slowestMs, detail }) => {
                readings.push({
                    id: readings.length + 1,
                    service_id: serviceId,
                    checked_at: checkedAt,
                    outcome,
                    file_count: fileCount,
                    slowest_ms: slowestMs,
                    detail
                });
            },
            listReadings: unused,
            lastConformAt: async (serviceId) => {
                const ats = readings
                    .filter((r) => r.service_id === serviceId && (r.outcome === 'learned' || r.outcome === 'conform'))
                    .map((r) => r.checked_at);
                return ats.length > 0 ? Math.max(...ats) : null;
            },
            pruneByRetention: async () => ({ checks: 0, readings: 0 })
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

describe('l’option d’intégrité', () => {
    const CAPTURE = {
        csp: "script-src 'self'",
        files: { '/': 'h-index', '/assets/app.js': 'h-app' },
        source: 'page' as const,
        slowestMs: 300
    };
    const BASELINE = JSON.stringify({ capturedAt: 1, csp: CAPTURE.csp, files: CAPTURE.files, source: 'page' });
    const read = (reading: IntegrityReading): ProbeOutcome => ({ ...UP, reading });
    const LEARNED = read({ kind: 'learned', slowestMs: 300, capture: CAPTURE });
    const CONFORM = read({ kind: 'conform', slowestMs: 20, fileCount: 2 });
    const DRIFT = read({
        kind: 'drift',
        slowestMs: 90,
        fileCount: 2,
        summary: '1 fichier modifié',
        lines: ['Modifié : /assets/app.js'],
        capture: { ...CAPTURE, files: { ...CAPTURE.files, '/assets/app.js': 'h-app-2' } }
    });
    const UNREADABLE = read({ kind: 'failed', error: 'Statut HTTP 404 sur /assets/app.js' });

    /** Le moniteur, et ce que chaque tour a demandé à la sonde : ne pas lire, apprendre, comparer. */
    function integrityMonitor(repo: FakeRepo) {
        const deps = createTestServiceDeps({ repo });
        const asked: string[] = [];
        let next: ProbeOutcome = UP;
        const monitor = new UptimeMonitor(deps, async (_target, _row, integrity) => {
            asked.push(integrity === null ? 'sans lecture' : integrity.baseline ? 'compare' : 'apprend');
            return next;
        });
        return {
            deps,
            monitor,
            asked,
            async probe(outcome: ProbeOutcome) {
                next = outcome;
                await deps.recorded.tickers[0].tick();
            },
            /** Le temps passe : la dernière lecture recule de `seconds`. */
            age(seconds: number) {
                repo.rows[0].integrity_checked_at = (repo.rows[0].integrity_checked_at ?? 0) - seconds;
            }
        };
    }

    it('dit quand lire : jamais sans l’option, d’emblée la première fois, à son rythme, cinq minutes après un raté', () => {
        const row = {
            integrity_interval_seconds: 900,
            integrity_checked_at: 1000,
            integrity_failures: 0,
            integrity_pending_since: null
        };
        assert.equal(integrityDue({ ...row, integrity_interval_seconds: null }, 5000, true), false);
        assert.equal(integrityDue({ ...row, integrity_checked_at: null }, 1000, false), true);
        assert.equal(integrityDue(row, 1899, false), false);
        assert.equal(integrityDue(row, 1900, false), true);
        assert.equal(integrityDue(row, 1001, true), true);
        assert.equal(integrityDue({ ...row, integrity_failures: 1 }, 1300, false), true);
        // Pendant l'attente d'un déploiement : une minute.
        assert.equal(integrityDue({ ...row, integrity_pending_since: 900 }, 1059, false), false);
        assert.equal(integrityDue({ ...row, integrity_pending_since: 900 }, 1060, false), true);
    });

    it('apprend sa référence à la première lecture, puis ne relit qu’à son rythme ou sur demande', async () => {
        const repo = fakeRepo({ integrity_interval_seconds: 900, failure_threshold: 1 });
        const { monitor, asked, probe, age } = integrityMonitor(repo);

        await probe(LEARNED);
        assert.equal(repo.rows[0].status, 'up');
        const stored = JSON.parse(repo.rows[0].baseline_enc!) as { files: Record<string, string>; csp: string };
        assert.deepEqual(stored.files, CAPTURE.files);
        assert.equal(stored.csp, CAPTURE.csp);
        // Le fichier le plus lent pèse sur la latence de la mesure.
        assert.equal(repo.rows[0].last_response_ms, 300);

        await probe(UP);
        await monitor.runOne({ ...repo.rows[0] }, { readFiles: true });
        age(900);
        await probe(CONFORM);
        assert.deepEqual(asked, ['apprend', 'sans lecture', 'compare', 'compare']);
        // Un site plus rapide que la page ne la fait pas paraître plus rapide.
        assert.equal(repo.rows[0].last_response_ms, 80);
        assert.equal(repo.checks.filter((c) => c.up === 0).length, 0);
    });

    it('une sonde sans l’option ne lit jamais', async () => {
        const repo = fakeRepo();
        const { asked, probe } = integrityMonitor(repo);
        await probe(UP);
        assert.deepEqual(asked, ['sans lecture']);
    });

    it('un écart tient chaque mesure en échec et alerte, l’acceptation le referme', async () => {
        const repo = fakeRepo({ integrity_interval_seconds: 900, baseline_enc: BASELINE });
        const { deps, probe } = integrityMonitor(repo);

        await probe(DRIFT);
        assert.equal(repo.rows[0].consecutive_failures, 1);
        assert.equal(repo.rows[0].last_response_ms, 90);
        assert.ok(repo.rows[0].integrity_verdict);

        // La sonde suivante ne relit pas les fichiers et la page répond : la
        // mesure échoue quand même, et le seuil fait la panne.
        await probe(UP);
        assert.equal(repo.checks[1].up, 0);
        assert.equal(repo.rows[0].status, 'down');
        assert.equal(repo.incidents.length, 1);
        // Le résumé sur la ligne du service, le détail fichier par fichier sur l'incident.
        assert.equal(repo.rows[0].last_error, 'Intégrité : 1 fichier modifié');
        assert.equal(repo.incidents[0].error, 'Intégrité : 1 fichier modifié\nModifié : /assets/app.js');
        assert.equal(deps.recorded.notifications.length, 1);
        assert.ok(deps.recorded.notifications[0].subject.includes('fichiers modifiés'));
        assert.ok(deps.recorded.notifications[0].body.includes('Modifié : /assets/app.js'));
        assert.equal(deps.recorded.audits[0].action, 'uptime.integrity');

        await probe(UP);
        assert.equal(repo.incidents.length, 1);
        assert.equal(repo.rows[0].status, 'down');

        // Accepter : la référence et l'écart oubliés, la lecture suivante apprend
        // et referme l'incident par le chemin ordinaire, « rétabli » compris.
        await repo.services.resetIntegrity(1);
        await probe(LEARNED);
        assert.equal(repo.rows[0].status, 'up');
        assert.notEqual(repo.incidents[0].ended_at, null);
        assert.equal(repo.rows[0].integrity_verdict, null);
        assert.equal(deps.recorded.notifications.length, 2);
        assert.ok(deps.recorded.notifications[1].subject.includes('de retour'));
    });

    it('une lecture qui retrouve la référence referme l’écart', async () => {
        const repo = fakeRepo({ integrity_interval_seconds: 900, baseline_enc: BASELINE, failure_threshold: 1 });
        const { probe, age } = integrityMonitor(repo);
        await probe(DRIFT);
        assert.equal(repo.rows[0].status, 'down');
        age(900);
        await probe(CONFORM);
        assert.equal(repo.rows[0].status, 'up');
        assert.equal(repo.rows[0].integrity_verdict, null);
        assert.notEqual(repo.incidents[0].ended_at, null);
    });

    it('une lecture ratée n’échoue que sa mesure, puis tient le service en panne au seuil', async () => {
        const repo = fakeRepo({ integrity_interval_seconds: 900, baseline_enc: BASELINE });
        const { deps, asked, probe, age } = integrityMonitor(repo);

        await probe(UNREADABLE);
        assert.equal(repo.checks[0].up, 0);
        assert.equal(repo.rows[0].last_error, 'Fichiers : Statut HTTP 404 sur /assets/app.js');
        assert.equal(repo.rows[0].integrity_failures, 1);
        assert.equal(repo.rows[0].integrity_verdict, null);

        // Isolée, elle n'est qu'une barre : la sonde suivante la rattrape.
        await probe(UP);
        assert.equal(repo.rows[0].consecutive_failures, 0);
        assert.equal(repo.incidents.length, 0);

        // Relue cinq minutes plus tard, pas au rythme de quinze.
        age(300);
        await probe(UNREADABLE);
        assert.equal(repo.rows[0].integrity_failures, 2);
        assert.ok(repo.rows[0].integrity_verdict);
        await probe(UP);
        assert.equal(repo.rows[0].status, 'down');
        assert.ok(deps.recorded.notifications[0].subject.includes('hors ligne'));
        assert.ok(deps.recorded.notifications[0].body.includes('Fichiers : Statut HTTP 404'));
        assert.deepEqual(asked, ['compare', 'sans lecture', 'compare', 'sans lecture']);
    });

    it('une page qui ne répond pas ne consomme pas la lecture due', async () => {
        const repo = fakeRepo({ integrity_interval_seconds: 900, baseline_enc: BASELINE });
        const { probe } = integrityMonitor(repo);
        await probe(DOWN);
        assert.equal(repo.rows[0].integrity_checked_at, null);
        assert.equal(repo.rows[0].last_error, DOWN.error);
        assert.equal(repo.readings.length, 0);
    });

    it('inscrit chaque lecture au journal des intégrités, et elle seule', async () => {
        const repo = fakeRepo({ integrity_interval_seconds: 900, failure_threshold: 3 });
        const { probe, age } = integrityMonitor(repo);

        await probe(LEARNED);
        await probe(UP);
        age(900);
        await probe(CONFORM);
        age(900);
        await probe(DRIFT);
        age(900);
        await probe(UNREADABLE);

        const entries = repo.readings.map((r) => ({
            outcome: r.outcome,
            files: r.file_count,
            ms: r.slowest_ms,
            detail: r.detail === null ? null : (JSON.parse(r.detail) as unknown)
        }));
        // Le harnais chiffre à l'identité : le détail se lit tel qu'il a été écrit.
        assert.deepEqual(entries, [
            { outcome: 'learned', files: 2, ms: 300, detail: null },
            { outcome: 'conform', files: 2, ms: 20, detail: null },
            {
                outcome: 'drift',
                files: 2,
                ms: 90,
                detail: { error: '1 fichier modifié', lines: ['Modifié : /assets/app.js'] }
            },
            {
                outcome: 'failed',
                files: null,
                ms: null,
                detail: { error: 'Statut HTTP 404 sur /assets/app.js', lines: [] }
            }
        ]);
    });
});

describe('l’acceptation après un déploiement', () => {
    const CAPTURE = {
        csp: null,
        files: { '/': 'h-index', '/assets/app.js': 'h-app' },
        source: 'page' as const,
        slowestMs: 40
    };
    const NEW_FILES = { '/': 'h-index-2', '/assets/app-2.js': 'h-app-2' };
    const BASELINE = JSON.stringify({ capturedAt: 1, csp: null, files: CAPTURE.files, source: 'page' });
    const DRIFT: ProbeOutcome = {
        ...UP,
        reading: {
            kind: 'drift',
            slowestMs: 40,
            fileCount: 2,
            summary: '1 fichier modifié, 1 fichier ajouté, 1 fichier retiré',
            lines: ['Modifié : /', 'Ajouté : /assets/app-2.js', 'Retiré : /assets/app.js'],
            capture: { ...CAPTURE, files: NEW_FILES }
        }
    };
    const now = () => Math.floor(Date.now() / 1000);
    /** Un service dont l'acceptation après un déploiement est allumée. */
    const ACCEPTING = JSON.stringify({
        name: 'API OxyFoo',
        url: 'https://api.oxyfoo.com/health',
        keyword: null,
        paths: [],
        deployAccept: true
    });

    /** Une cible de Déploiements dont le test décide l'activité, et les débuts de fenêtre qu'on lui a demandés. */
    function deployWith(answer: (since: number) => DeployActivity) {
        const asked: number[] = [];
        const provider: DeployItemsProvider = {
            exists: async () => true,
            labelOf: async () => 'app',
            list: async () => [],
            authorize: async () => ({ ok: true }),
            activity: async (_id, _ws, since) => {
                asked.push(since);
                return answer(since);
            }
        };
        return { asked, provider };
    }

    function setup(answer: (since: number) => DeployActivity, over: Partial<UptimeServiceRow> = {}) {
        const repo = fakeRepo({
            integrity_interval_seconds: 900,
            baseline_enc: BASELINE,
            failure_threshold: 1,
            content: ACCEPTING,
            ...over
        });
        repo.sources.push({ service_id: 1, kind: 'deploy', ref_id: 5 });
        const deploy = deployWith(answer);
        const deps = createTestServiceDeps({ repo, providers: { [DEPLOY_ITEMS_PROVIDER]: deploy.provider } });
        const { probe } = monitorWith(repo, deps);
        return { repo, deps, probe, asked: deploy.asked };
    }

    it('accepte un écart qu’un déploiement explique : référence remplacée, mesure verte, aucune alerte', async () => {
        const { repo, deps, probe } = setup(
            () => ({ succeeded: { at: now() - 30, what: 'le déploiement « app »' }, inFlight: null, error: null }),
            { status: 'up' }
        );
        await probe(DRIFT);

        assert.equal(repo.rows[0].status, 'up');
        assert.equal(repo.checks[0].up, 1);
        assert.equal(repo.rows[0].integrity_verdict, null);
        assert.deepEqual((JSON.parse(repo.rows[0].baseline_enc!) as { files: unknown }).files, NEW_FILES);
        assert.equal(repo.incidents.length, 0);
        assert.equal(deps.recorded.notifications.length, 0);
        assert.equal(repo.readings[0].outcome, 'accepted');
        const detail = JSON.parse(repo.readings[0].detail!) as { error: string; lines: string[] };
        assert.ok(detail.error.startsWith('Expliquée par le déploiement « app » ('));
        assert.deepEqual(detail.lines, ['Modifié : /', 'Ajouté : /assets/app-2.js', 'Retiré : /assets/app.js']);
        const audit = deps.recorded.audits.find((a) => a.action === 'uptime.baselineAccepted');
        assert.ok(audit?.description.includes('acceptée automatiquement'));
        // L'état ne bascule pas : seule l'acceptation prévient les écrans.
        assert.deepEqual(deps.recorded.liveChanges, [1]);
    });

    it('attend un déploiement en cours sans échouer, puis accepte quand il aboutit', async () => {
        let done = false;
        const { repo, deps, probe } = setup(() =>
            done
                ? { succeeded: { at: now(), what: 'le déploiement « app »' }, inFlight: null, error: null }
                : { succeeded: null, inFlight: { what: 'le déploiement « app »' }, error: null }
        );
        await probe(DRIFT);
        assert.equal(repo.rows[0].status, 'up');
        assert.equal(repo.rows[0].integrity_verdict, null);
        assert.notEqual(repo.rows[0].integrity_pending_since, null);
        assert.equal(repo.readings[0].outcome, 'pending');
        assert.equal(
            (JSON.parse(repo.readings[0].detail!) as { error: string }).error,
            'Le déploiement « app » est en cours : 1 fichier modifié, 1 fichier ajouté, 1 fichier retiré'
        );

        done = true;
        repo.rows[0].integrity_checked_at! -= 60;
        await probe(DRIFT);
        assert.equal(repo.readings[1].outcome, 'accepted');
        assert.equal(repo.rows[0].integrity_pending_since, null);
        assert.equal(deps.recorded.notifications.length, 0);
    });

    it('une attente trop longue redevient l’alerte ordinaire, et le journal dit pourquoi', async () => {
        const { repo, deps, probe } = setup(
            () => ({ succeeded: null, inFlight: { what: 'le déploiement « app »' }, error: null }),
            { integrity_pending_since: Math.floor(Date.now() / 1000) - 1801 }
        );
        await probe(DRIFT);
        assert.equal(repo.rows[0].status, 'down');
        assert.equal(repo.rows[0].integrity_pending_since, null);
        assert.equal(deps.recorded.notifications.length, 1);
        // La note reste au journal : l'alerte ne porte que l'écart.
        assert.ok(!deps.recorded.notifications[0].body.includes('n’a pas abouti'));
        const detail = JSON.parse(repo.readings[0].detail!) as { lines: string[] };
        assert.ok(detail.lines.includes('Le déploiement « app » n’a pas abouti en 30 min'));
    });

    it('un déploiement terminé avant la dernière lecture conforme n’explique rien', async () => {
        const conformAt = now() - 600;
        const deployedAt = conformAt - 400;
        const { repo, asked, probe } = setup((since) => ({
            succeeded: deployedAt >= since ? { at: deployedAt, what: 'le déploiement « app »' } : null,
            inFlight: null,
            error: null
        }));
        repo.readings.push({
            id: 99,
            service_id: 1,
            checked_at: conformAt,
            outcome: 'conform',
            file_count: 2,
            slowest_ms: 10,
            detail: null
        });
        await probe(DRIFT);
        assert.equal(asked[0], conformAt - 300);
        assert.equal(repo.rows[0].status, 'down');
        const detail = JSON.parse(repo.readings[1].detail!) as { lines: string[] };
        assert.ok(detail.lines.includes('Aucun déploiement de ses sources ne l’explique'));
    });

    it('l’adresse d’appel suffit à expliquer un écart', async () => {
        const repo = fakeRepo({
            integrity_interval_seconds: 900,
            baseline_enc: BASELINE,
            content: ACCEPTING,
            deploy_hook_hash: 'h',
            deploy_hook_at: Math.floor(Date.now() / 1000) - 5
        });
        const { probe } = monitorWith(repo);
        await probe(DRIFT);
        assert.equal(repo.readings[0].outcome, 'accepted');
        assert.ok((JSON.parse(repo.readings[0].detail!) as { error: string }).error.includes('par l’adresse d’appel'));
    });

    it('l’acceptation éteinte, les sources gardées ne sont pas interrogées', async () => {
        const { repo, asked, probe } = setup(
            () => ({ succeeded: { at: now(), what: 'le déploiement « app »' }, inFlight: null, error: null }),
            {
                content: JSON.stringify({
                    name: 'API OxyFoo',
                    url: 'https://api.oxyfoo.com/health',
                    keyword: null,
                    paths: []
                })
            }
        );
        await probe(DRIFT);
        assert.deepEqual(asked, []);
        assert.equal(repo.rows[0].status, 'down');
    });

    it('un service sans source garde l’écart tel quel, sans rien demander', async () => {
        const repo = fakeRepo({ integrity_interval_seconds: 900, baseline_enc: BASELINE, failure_threshold: 1 });
        const { probe } = monitorWith(repo);
        await probe(DRIFT);
        assert.equal(repo.rows[0].status, 'down');
        assert.deepEqual(JSON.parse(repo.readings[0].detail!), {
            error: '1 fichier modifié, 1 fichier ajouté, 1 fichier retiré',
            lines: ['Modifié : /', 'Ajouté : /assets/app-2.js', 'Retiré : /assets/app.js']
        });
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
