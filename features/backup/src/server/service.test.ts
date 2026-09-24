import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DeviceReport } from '@deveye/types';
import type { FeatureServiceDeps } from '@deveye/types/sdk/server';
import { createTestServiceDeps, testDevice, type TestFolderArchive } from '@deveye/types/sdk/testing';

import type { BackupDestinationRow, BackupJobRow, BackupRunRow } from '../contracts/domain';
import type { BackupRepo } from './repo';
import { BackupEngine, destinationInside } from './service';
import type { StoredFolder, StoredRun } from './_shared';

/**
 * Un passage de bout en bout, une machine pour source et une autre pour
 * destination : les droits de l'auteur relus, l'archive de l'agent écrite
 * telle quelle, ce qu'elle a laissé de côté retenu sur l'exécution.
 */

const NAS = '11111111-1111-4111-8111-111111111111';
const PI = '22222222-2222-4222-8222-222222222222';
const capable = { agent: { probes: ['folderArchive'] } } as unknown as DeviceReport;

interface Finished {
    status: 'success' | 'failed';
    sizeBytes: number;
    run: StoredRun;
}

function engineFor(options: {
    folder?: Partial<StoredFolder>;
    destination?: { deviceId: string; path: string };
    archives?: Record<string, TestFolderArchive | Error>;
    access?: Partial<FeatureServiceDeps['access']>;
    nasReport?: DeviceReport | null;
}) {
    let finish: (value: Finished) => void = () => undefined;
    const finished = new Promise<Finished>((resolve) => (finish = resolve));
    const destination: BackupDestinationRow = {
        id: 1,
        workspace_id: 1,
        kind: 'device',
        device_id: options.destination?.deviceId ?? PI,
        path_style: 1,
        status: 'ok',
        checked_at: null,
        content: JSON.stringify({ name: 'Disque du Pi', path: options.destination?.path ?? '/mnt/backup' }),
        secret_enc: '',
        created: 1
    };
    const repo = {
        findDestinationForJob: async () => destination,
        startRun: async (input: { jobId: number; triggeredByUserId: number | null; content: string }) =>
            ({
                id: 50,
                job_id: input.jobId,
                workspace_id: 1,
                status: 'running',
                started_at: 1,
                finished_at: null,
                size_bytes: 0,
                checksum: null,
                encrypted: 0,
                triggered_by_user_id: input.triggeredByUserId,
                pruned: 0,
                content: input.content
            }) satisfies BackupRunRow,
        finishRun: async (_id: number, input: { status: 'success' | 'failed'; sizeBytes: number; content: string }) =>
            finish({ status: input.status, sizeBytes: input.sizeBytes, run: JSON.parse(input.content) }),
        listRunsToPrune: async () => [],
        markPruned: async () => undefined,
        storedBytesInWorkspaces: async () => 0,
        setNextRun: async () => undefined,
        failStaleRuns: async () => 0
    } as unknown as BackupRepo;

    const deps = createTestServiceDeps({
        repo,
        devices: [
            testDevice({ id: NAS, name: 'NAS', report: options.nasReport === undefined ? capable : options.nasReport }),
            testDevice({ id: PI, name: 'Pi', report: capable })
        ],
        archives: options.archives,
        access: options.access
    });
    const folder: StoredFolder = {
        deviceId: NAS,
        path: '/srv/www',
        exclusions: [{ kind: 'name', pattern: 'node_modules' }],
        oneFileSystem: true,
        authorUserId: 5,
        ...options.folder
    };
    const job: BackupJobRow = {
        id: 10,
        workspace_id: 1,
        destination_id: 1,
        source_kind: 'deviceFolder',
        source_id: null,
        enabled: 1,
        schedule_kind: 'daily',
        schedule_hour: 3,
        schedule_weekday: 0,
        schedule_day: 1,
        keep_last: 7,
        encryption: 'none',
        next_run_at: null,
        content: JSON.stringify({ name: 'Site web', folder }),
        created: 1
    };
    return { engine: new BackupEngine(deps), deps, job, finished };
}

const pieces = [Buffer.from('\x1f\x8b-un'), Buffer.from('-deux')];

describe('Backup : moteur, fichiers d’une machine', () => {
    it('écrit l’archive de l’agent telle quelle, et retient ce qu’elle a laissé de côté', async () => {
        const { engine, deps, job, finished } = engineFor({
            archives: {
                [NAS]: {
                    chunks: pieces,
                    summary: { skipped: 2, samples: [{ path: '/srv/www/secret', reason: 'Permission denied' }] }
                }
            }
        });
        await engine.trigger(job, 5);
        const out = await finished;

        assert.equal(out.status, 'success', out.run.error ?? undefined);
        // Pas de recompression : la taille écrite est celle des pièces.
        assert.equal(
            out.sizeBytes,
            pieces.reduce((n, p) => n + p.length, 0)
        );
        assert.match(out.run.artifact ?? '', /nas-www-\d{8}-\d{6}\.tar\.gz$/);
        assert.equal(out.run.warning, '2 éléments illisibles ignorés. Premiers : /srv/www/secret (Permission denied).');
        assert.deepEqual(deps.recorded.archiveRequests, [
            {
                deviceId: NAS,
                path: '/srv/www',
                exclusions: [{ kind: 'name', pattern: 'node_modules' }],
                oneFileSystem: true
            }
        ]);
    });

    it('un auteur qui a perdu le droit Fichiers arrête le travail, et le dit', async () => {
        const { engine, deps, job, finished } = engineFor({
            archives: { [NAS]: { chunks: pieces } },
            access: { device: async () => ({ ok: false, reason: 'not_granted' }) }
        });
        await engine.trigger(job, null as unknown as number);
        const out = await finished;

        assert.equal(out.status, 'failed');
        assert.match(out.run.error ?? '', /n’a plus le droit Fichiers.*la permission lui a été retirée/);
        assert.equal(deps.recorded.archiveRequests.length, 0);
        // L'avis part juste après l'enregistrement de l'exécution.
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(deps.recorded.notifications.length, 1);
    });

    it('un auteur qui n’est plus membre ne sauvegarde plus rien', async () => {
        const { engine, job, finished } = engineFor({
            archives: { [NAS]: { chunks: pieces } },
            access: { feature: async () => ({ ok: false, reason: 'not_member' }) }
        });
        await engine.trigger(job, 5);
        assert.match((await finished).run.error ?? '', /n’est plus membre/);
    });

    it('un agent qui ne sait pas archiver échoue avant de rien demander', async () => {
        const { engine, deps, job, finished } = engineFor({ nasReport: null });
        await engine.trigger(job, 5);
        assert.match((await finished).run.error ?? '', /à mettre à jour/);
        assert.equal(deps.recorded.archiveRequests.length, 0);
    });

    it('une destination sous le dossier sauvegardé en est exclue d’office', async () => {
        const { engine, deps, job, finished } = engineFor({
            destination: { deviceId: NAS, path: '/srv/www/sauvegardes/' },
            archives: { [NAS]: { chunks: pieces } }
        });
        await engine.trigger(job, 5);
        assert.equal((await finished).status, 'success');
        assert.deepEqual(deps.recorded.archiveRequests[0].exclusions, [
            { kind: 'name', pattern: 'node_modules' },
            { kind: 'path', pattern: 'sauvegardes' }
        ]);
    });

    it('une destination qui est le dossier même est refusée', async () => {
        const { engine, finished, job } = engineFor({
            destination: { deviceId: NAS, path: '/srv/www' },
            archives: { [NAS]: { chunks: pieces } }
        });
        await engine.trigger(job, 5);
        assert.match((await finished).run.error ?? '', /dossier même/);
    });
});

describe('destinationInside', () => {
    it('rend le chemin relatif d’une destination sous la source, et rien ailleurs', () => {
        assert.equal(destinationInside('/srv/www', '/srv/www/a/b'), 'a/b');
        assert.equal(destinationInside('/srv/www', '/srv/wwwx'), null);
        assert.equal(destinationInside('/srv/www/', '/srv/www'), '');
        assert.equal(destinationInside('/', '/mnt/backup'), 'mnt/backup');
        assert.equal(destinationInside('C:\\Users\\Moi', 'c:\\users\\moi\\Sauvegardes'), 'Sauvegardes');
    });
});
