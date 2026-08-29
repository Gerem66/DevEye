import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import {
    backupDestinationAdd,
    backupDestinationRemove,
    backupJobList,
    backupJobRemove,
    backupJobRun,
    backupJobUpdate,
    backupSources
} from '../contracts/commands';
import type {
    BackupDestinationRow,
    BackupDestinationWithUsageRow,
    BackupJobRow,
    BackupJobWithStateRow,
    BackupRunRow
} from '../contracts/domain';
import {
    CLOUDSYNC_BACKUP_PROVIDER,
    DATABASE_BACKUP_PROVIDER,
    type CloudSyncBackupProvider,
    type DatabaseBackupProvider
} from '@deveye/types/sdk';
import { FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext, testDevice } from '@deveye/types/sdk/testing';

import { backupHandlers } from './handlers';
import type { BackupRepo } from './repo';
import type { BackupEngine } from './service';
import { setEngine } from './_shared';

/**
 * Ce qui ne lève nulle part quand ça se dérègle : l'appartenance d'un appareil
 * à l'espace, le refus de retirer une destination visée, les restrictions par
 * élément, le partage, le ménage à la suppression, les contrats consommés.
 */

/** Le handler d'un contrat, typé par ce contrat (le registre est hétérogène). */
function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = backupHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<BackupRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

const failsWith =
    (code: FeatureError['code']) =>
    (e: unknown): boolean =>
        e instanceof FeatureError && e.code === code;

interface FakeRepo extends BackupRepo {
    destinations: BackupDestinationRow[];
    jobs: BackupJobRow[];
    runs: BackupRunRow[];
}

/** Une destination en base, telle que le vrai dépôt la rendrait (contenu en clair : le harnais chiffre à l'identité). */
function destination(over: Partial<BackupDestinationRow> & { id: number; workspace_id: number }): BackupDestinationRow {
    return {
        kind: 'local',
        device_id: null,
        path_style: 1,
        status: 'unknown',
        checked_at: null,
        content: JSON.stringify({ name: `Destination ${over.id}`, path: 'nuit' }),
        secret_enc: '',
        created: 1,
        ...over
    };
}

function job(over: Partial<BackupJobRow> & { id: number; workspace_id: number }): BackupJobRow {
    return {
        destination_id: 1,
        source_kind: 'deveye',
        source_id: null,
        enabled: 1,
        schedule_kind: 'daily',
        schedule_hour: 3,
        schedule_weekday: 0,
        schedule_day: 1,
        keep_last: 7,
        encryption: 'server',
        next_run_at: null,
        content: JSON.stringify({ name: `Travail ${over.id}` }),
        created: 1,
        ...over
    };
}

/**
 * Dépôt en mémoire. `projections` reproduit `item_shares` (`jobId → espaces où
 * il est projeté`), ce que le harnais (`shares`) doit dire en écho.
 */
function fakeRepo(projections: Record<number, number[]> = {}): FakeRepo {
    let seq = 100;
    const destinations: BackupDestinationRow[] = [];
    const jobs: BackupJobRow[] = [];
    const runs: BackupRunRow[] = [];
    const visible = (j: BackupJobRow, workspaceId: number) =>
        j.workspace_id === workspaceId || (projections[j.id] ?? []).includes(workspaceId);
    const withState = (j: BackupJobRow): BackupJobWithStateRow => {
        const dest = destinations.find((d) => d.id === j.destination_id);
        return {
            ...j,
            destination_kind: dest?.kind ?? 'local',
            destination_content: dest?.content ?? '',
            last_run_at: null,
            last_status: null,
            last_run_content: null,
            total_bytes: 0,
            run_count: 0
        };
    };
    const withUsage = (d: BackupDestinationRow): BackupDestinationWithUsageRow => ({
        ...d,
        job_count: jobs.filter((j) => j.destination_id === d.id).length,
        device_name: null
    });

    return {
        destinations,
        jobs,
        runs,
        listDestinations: async (workspaceId) =>
            destinations.filter((d) => d.workspace_id === workspaceId).map(withUsage),
        findDestination: async (id, workspaceId) =>
            destinations.find((d) => d.id === id && d.workspace_id === workspaceId) ?? null,
        findDestinationForJob: async (jobId) => {
            const j = jobs.find((x) => x.id === jobId);
            return (j && destinations.find((d) => d.id === j.destination_id)) ?? null;
        },
        async createDestination(input) {
            const created = destination({
                id: ++seq,
                workspace_id: input.workspaceId,
                kind: input.kind,
                device_id: input.deviceId,
                path_style: input.pathStyle ? 1 : 0,
                content: input.content,
                secret_enc: input.secretEnc
            });
            destinations.push(created);
            return created;
        },
        async updateDestination(id, workspaceId, input) {
            const target = destinations.find((d) => d.id === id && d.workspace_id === workspaceId);
            if (!target) return null;
            Object.assign(target, {
                device_id: input.deviceId,
                path_style: input.pathStyle ? 1 : 0,
                content: input.content
            });
            if (input.secretEnc !== undefined) target.secret_enc = input.secretEnc;
            return target;
        },
        recordDestinationProbe: async () => undefined,
        async deleteDestination(id, workspaceId) {
            const i = destinations.findIndex((d) => d.id === id && d.workspace_id === workspaceId);
            if (i === -1) return false;
            destinations.splice(i, 1);
            return true;
        },
        countJobsUsing: async (destinationId) => jobs.filter((j) => j.destination_id === destinationId).length,
        listJobs: async (workspaceId) => jobs.filter((j) => j.workspace_id === workspaceId).map(withState),
        listVisibleJobs: async (workspaceId) => jobs.filter((j) => visible(j, workspaceId)).map(withState),
        findJob: async (id, workspaceId) => jobs.find((j) => j.id === id && j.workspace_id === workspaceId) ?? null,
        findVisibleJob: async (id, workspaceId) => jobs.find((j) => j.id === id && visible(j, workspaceId)) ?? null,
        findJobWithState: async (id, workspaceId) => {
            const j = jobs.find((x) => x.id === id && x.workspace_id === workspaceId);
            return j ? withState(j) : null;
        },
        findVisibleJobWithState: async (id, workspaceId) => {
            const j = jobs.find((x) => x.id === id && visible(x, workspaceId));
            return j ? withState(j) : null;
        },
        findJobById: async (id) => jobs.find((j) => j.id === id) ?? null,
        countJobs: async (workspaceId) => ({
            count: jobs.filter((j) => j.workspace_id === workspaceId && j.enabled === 1).length,
            failing: 0
        }),
        async createJob(input) {
            const created = job({
                id: ++seq,
                workspace_id: input.workspaceId,
                destination_id: input.destinationId,
                source_kind: input.sourceKind,
                source_id: input.sourceId,
                enabled: input.enabled ? 1 : 0,
                schedule_kind: input.scheduleKind,
                schedule_hour: input.scheduleHour,
                schedule_weekday: input.scheduleWeekday,
                schedule_day: input.scheduleDay,
                keep_last: input.keepLast,
                encryption: input.encryption,
                next_run_at: input.nextRunAt,
                content: input.content
            });
            jobs.push(created);
            return created;
        },
        async updateJob(id, workspaceId, input) {
            const target = jobs.find((j) => j.id === id && j.workspace_id === workspaceId);
            if (!target) return null;
            Object.assign(target, {
                destination_id: input.destinationId,
                source_kind: input.sourceKind,
                source_id: input.sourceId,
                enabled: input.enabled ? 1 : 0,
                schedule_kind: input.scheduleKind,
                schedule_hour: input.scheduleHour,
                schedule_weekday: input.scheduleWeekday,
                schedule_day: input.scheduleDay,
                keep_last: input.keepLast,
                encryption: input.encryption,
                next_run_at: input.nextRunAt,
                content: input.content
            });
            return target;
        },
        async deleteJob(id, workspaceId) {
            const i = jobs.findIndex((j) => j.id === id && j.workspace_id === workspaceId);
            if (i === -1) return false;
            jobs.splice(i, 1);
            return true;
        },
        listJobsDue: async () => [],
        setNextRun: async () => undefined,
        listRuns: async (jobId) => runs.filter((r) => r.job_id === jobId),
        listWorkspaceRuns: async (workspaceId) => runs.filter((r) => r.workspace_id === workspaceId),
        findRun: async (id) => runs.find((r) => r.id === id) ?? null,
        async startRun(input) {
            const created: BackupRunRow = {
                id: ++seq,
                job_id: input.jobId,
                workspace_id: input.workspaceId,
                status: 'running',
                started_at: 1,
                finished_at: null,
                size_bytes: 0,
                checksum: null,
                encrypted: input.encrypted ? 1 : 0,
                triggered_by_user_id: input.triggeredByUserId,
                pruned: 0,
                content: input.content
            };
            runs.push(created);
            return created;
        },
        finishRun: async () => undefined,
        listRunsToPrune: async () => [],
        markPruned: async () => undefined,
        failStaleRuns: async () => 0
    };
}

/** Le contrat de Bases de données, tel que l'app (ou son module) l'offre. */
const databases: DatabaseBackupProvider = {
    listDatabases: async (workspaceId) =>
        workspaceId === 1 ? [{ id: 7, name: 'Prod', engine: 'mysql', host: 'db.exemple.fr', database: 'shop' }] : [],
    findDatabase: async (id, workspaceId) =>
        id === 7 && workspaceId === 1
            ? { id: 7, name: 'Prod', engine: 'mysql', host: 'db.exemple.fr', database: 'shop' }
            : null,
    openAccess: async () => null
};

/** Le contrat CloudSync, réduit à ce que le sélecteur demande. */
const cloudSync: CloudSyncBackupProvider = {
    findShare: async (id) => (id === 3 ? { id: 3, name: 'Photos', workspaceId: 1, userId: 1 } : null),
    listShares: async (workspaceId) =>
        workspaceId === 1 ? [{ id: 3, name: 'Photos', workspaceId: 1, userId: 1 }] : [],
    statsByShare: async () => ({ fileCount: 12, liveBytes: 4096 }),
    listPresentFiles: async () => [],
    openBlob: async () => {
        throw new Error('non attendu ici');
    }
};

/** Le moteur, réduit à ce que ces handlers lui demandent ; `running` dit ce qui tourne. */
function fakeEngine(running: number[] = []): { triggered: number[] } {
    const calls = { triggered: [] as number[] };
    setEngine({
        isRunning: (jobId: number) => running.includes(jobId),
        trigger: async (j: BackupJobRow, userId: number) => {
            calls.triggered.push(j.id);
            return {
                id: 500,
                job_id: j.id,
                workspace_id: j.workspace_id,
                status: 'running',
                started_at: 1,
                finished_at: null,
                size_bytes: 0,
                checksum: null,
                encrypted: 1,
                triggered_by_user_id: userId,
                pruned: 0,
                content: JSON.stringify({ artifact: null, error: null })
            } satisfies BackupRunRow;
        }
    } as unknown as BackupEngine);
    return calls;
}

describe('Backup : handlers', () => {
    afterEach(() => setEngine(null));

    it('n’accepte comme destination qu’une machine de l’espace', async () => {
        const repo = fakeRepo();
        const ctx = createTestContext({ repo, workspaceId: 1, devices: [testDevice({ id: 'dev-a', name: 'Pi' })] });
        const add = handlerFor(backupDestinationAdd);
        const body = {
            kind: 'device' as const,
            name: 'Le Pi',
            path: '/mnt/backup',
            endpoint: null,
            region: null,
            bucket: null,
            accessKeyId: null,
            secret: null,
            pathStyle: true
        };

        await assert.rejects(add(ctx, { ...body, deviceId: 'dev-etranger' }), failsWith('not_found'));
        assert.equal(repo.destinations.length, 0);

        const out = await add(ctx, { ...body, deviceId: 'dev-a' });
        assert.equal(out.destination.kind, 'device');
        assert.equal(out.destination.deviceId, 'dev-a');
        assert.equal(out.destination.hasSecret, false);
        assert.deepEqual(
            ctx.recorded.audits.map((a) => a.action),
            ['backup.destinationAdd']
        );
    });

    it('refuse de retirer une destination encore visée, en disant combien', async () => {
        const repo = fakeRepo();
        repo.destinations.push(destination({ id: 1, workspace_id: 1 }));
        repo.jobs.push(job({ id: 10, workspace_id: 1 }), job({ id: 11, workspace_id: 1 }));
        const ctx = createTestContext({ repo, workspaceId: 1 });

        await assert.rejects(
            handlerFor(backupDestinationRemove)(ctx, { destinationId: 1 }),
            (e: unknown) => e instanceof FeatureError && e.code === 'conflict' && /^2 travail/.test(e.message)
        );
        assert.equal(repo.destinations.length, 1);
    });

    it('liste ce que le rôle voit : les masqués disparaissent, les projetés portent leur pastille', async () => {
        const repo = fakeRepo({ 30: [1] });
        repo.destinations.push(destination({ id: 1, workspace_id: 1 }), destination({ id: 2, workspace_id: 2 }));
        repo.jobs.push(
            job({ id: 10, workspace_id: 1 }),
            job({ id: 11, workspace_id: 1 }),
            job({ id: 30, workspace_id: 2, destination_id: 2 })
        );
        const ctx = createTestContext({ repo, workspaceId: 1, itemRestrictions: { 11: 'none' }, shares: { 30: 2 } });

        const out = await handlerFor(backupJobList)(ctx, {});

        assert.deepEqual(
            out.jobs.map((j) => [j.id, j.foreign]),
            [
                [10, false],
                [30, true]
            ]
        );
    });

    it('un travail projeté se lance d’ici mais ne se modifie ni ne se supprime que chez lui', async () => {
        const repo = fakeRepo({ 30: [1] });
        repo.destinations.push(destination({ id: 2, workspace_id: 2 }));
        repo.jobs.push(job({ id: 30, workspace_id: 2, destination_id: 2 }));
        const ctx = createTestContext({ repo, workspaceId: 1, shares: { 30: 2 } });
        const engine = fakeEngine();

        const update = {
            jobId: 30,
            name: 'Pirate',
            destinationId: 2,
            encryption: 'server' as const,
            source: 'deveye' as const,
            sourceId: null,
            enabled: true,
            schedule: 'daily' as const,
            scheduleHour: 3,
            scheduleWeekday: 0,
            scheduleDay: 1,
            keepLast: 7
        };
        await assert.rejects(handlerFor(backupJobUpdate)(ctx, update), failsWith('forbidden'));
        await assert.rejects(handlerFor(backupJobRemove)(ctx, { jobId: 30 }), failsWith('forbidden'));
        assert.equal(repo.jobs.length, 1);

        const out = await handlerFor(backupJobRun)(ctx, { jobId: 30 });
        assert.equal(out.run.status, 'running');
        assert.deepEqual(engine.triggered, [30]);
    });

    it('supprimer un travail fait le ménage de ses projections et de sa route', async () => {
        const repo = fakeRepo();
        repo.destinations.push(destination({ id: 1, workspace_id: 1 }));
        repo.jobs.push(job({ id: 10, workspace_id: 1 }));
        const ctx = createTestContext({ repo, workspaceId: 1 });
        fakeEngine();

        assert.deepEqual(await handlerFor(backupJobRemove)(ctx, { jobId: 10 }), { jobId: 10 });

        assert.deepEqual(repo.jobs, []);
        assert.deepEqual(ctx.forgotten, [10]);
    });

    it('un travail en cours ne se supprime pas', async () => {
        const repo = fakeRepo();
        repo.destinations.push(destination({ id: 1, workspace_id: 1 }));
        repo.jobs.push(job({ id: 10, workspace_id: 1 }));
        const ctx = createTestContext({ repo, workspaceId: 1 });
        fakeEngine([10]);

        await assert.rejects(handlerFor(backupJobRemove)(ctx, { jobId: 10 }), failsWith('conflict'));
        assert.equal(repo.jobs.length, 1);
    });

    it('les sources viennent de leurs contrats, et une source sans contrat disparaît du sélecteur', async () => {
        const repo = fakeRepo();
        const both = createTestContext({
            repo,
            workspaceId: 1,
            providers: { [DATABASE_BACKUP_PROVIDER]: databases, [CLOUDSYNC_BACKUP_PROVIDER]: cloudSync }
        });
        const out = await handlerFor(backupSources)(both, {});
        assert.deepEqual(
            out.candidates.map((c) => [c.kind, c.id, c.name, c.available]),
            [
                ['deveye', null, 'Base de DevEye', true],
                ['database', 7, 'Prod', true],
                ['cloudsync', 3, 'Photos', true]
            ]
        );

        const none = createTestContext({ repo, workspaceId: 1 });
        const bare = await handlerFor(backupSources)(none, {});
        assert.deepEqual(
            bare.candidates.map((c) => c.kind),
            ['deveye']
        );
    });

    it('un travail sur une base n’existe que si Bases de données la connaît dans cet espace', async () => {
        const repo = fakeRepo();
        repo.destinations.push(destination({ id: 1, workspace_id: 1 }));
        const ctx = createTestContext({ repo, workspaceId: 1, providers: { [DATABASE_BACKUP_PROVIDER]: databases } });
        const add = handlerFor(backupJobUpdate);
        void add;
        const create = backupHandlers.find((h) => h.command === 'backup.jobAdd');
        assert.ok(create);
        const body = {
            name: 'Prod, la nuit',
            destinationId: 1,
            encryption: 'server' as const,
            source: 'database' as const,
            enabled: true,
            schedule: 'daily' as const,
            scheduleHour: 3,
            scheduleWeekday: 0,
            scheduleDay: 1,
            keepLast: 7
        };

        await assert.rejects(create.handler(ctx, { ...body, sourceId: 8 }), failsWith('not_found'));
        const out = (await create.handler(ctx, { ...body, sourceId: 7 })) as { job: { sourceName: string | null } };
        assert.equal(out.job.sourceName, 'Prod');
        assert.equal(repo.jobs[0].source_id, 7);
    });
});
