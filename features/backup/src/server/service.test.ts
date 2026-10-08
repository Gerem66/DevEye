import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DeviceReport } from '@deveye/types';
import {
    HOSTING_BACKUP_PROVIDER,
    MAILSERVER_BACKUP_PROVIDER,
    type MailServerBackupProvider,
    type TreeBackupProvider
} from '@deveye/types/sdk';
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
    dockerInventory?: FeatureServiceDeps['agents']['dockerInventory'];
    providers?: Readonly<Record<string, unknown>>;
    /** Un autre genre de source que le dossier par défaut. */
    job?: Pick<BackupJobRow, 'source_kind' | 'source_id' | 'content'>;
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
        access: options.access,
        dockerInventory: options.dockerInventory,
        providers: options.providers
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
        created: 1,
        ...options.job
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

describe('Backup : moteur, volume Docker', () => {
    const job = {
        source_kind: 'dockerVolume',
        source_id: null,
        content: JSON.stringify({
            name: 'Base',
            volume: { deviceId: NAS, engine: 'docker', name: 'pgdata' },
            authorUserId: 5
        })
    };
    const inventoryOf = (
        volumes: { engine: 'docker' | 'podman'; name: string; driver: string; mountpoint: string }[]
    ) => Promise.resolve({ engines: [], containers: [], images: [], networks: [], volumes });

    it('relit le chemin du volume dans l’inventaire, puis l’archive comme un dossier', async () => {
        const {
            engine,
            deps,
            job: row,
            finished
        } = engineFor({
            job,
            archives: { [NAS]: { chunks: pieces } },
            dockerInventory: () =>
                inventoryOf([
                    {
                        engine: 'docker',
                        name: 'pgdata',
                        driver: 'local',
                        mountpoint: '/data/docker/volumes/pgdata/_data'
                    }
                ])
        });
        await engine.trigger(row, 5);
        const out = await finished;
        assert.equal(out.status, 'success', out.run.error ?? undefined);
        assert.match(out.run.artifact ?? '', /nas-pgdata-\d{8}-\d{6}\.tar\.gz$/);
        assert.deepEqual(deps.recorded.archiveRequests, [
            { deviceId: NAS, path: '/data/docker/volumes/pgdata/_data', exclusions: [], oneFileSystem: true }
        ]);
    });

    it('un volume disparu, ou une machine muette, font échouer le passage en le disant', async () => {
        const gone = engineFor({ job, dockerInventory: () => inventoryOf([]) });
        await gone.engine.trigger(gone.job, 5);
        assert.match((await gone.finished).run.error ?? '', /volume « pgdata » n’existe plus sur « NAS »/);

        const mute = engineFor({ job, dockerInventory: () => Promise.resolve(null) });
        await mute.engine.trigger(mute.job, 5);
        assert.match((await mute.finished).run.error ?? '', /ne répond pas/);
        assert.equal(mute.deps.recorded.archiveRequests.length, 0);
    });
});

describe('Backup : moteur, adresse du Serveur mail', () => {
    const job = {
        source_kind: 'mailbox',
        source_id: 9,
        content: JSON.stringify({ name: 'Courrier', authorUserId: 5 })
    };
    const mailOf = (allowed: boolean): MailServerBackupProvider => ({
        listMailboxes: async () => [],
        findMailbox: async (id, workspaceId) =>
            id === 9 && workspaceId === 1
                ? { id: 9, address: 'contact@exemple.fr', workspaceId: 1, messageCount: 1, bytes: 10 }
                : null,
        folders: async () => [{ id: 1, path: 'INBOX', specialUse: null, subscribed: true, keywords: [] }],
        messages: async (_m, _f, afterUid) =>
            afterUid > 0
                ? []
                : [{ id: 3, uid: 1, size: 5, internalDate: 1_788_000_000, flags: ['seen'], keywords: [] }],
        open: async () =>
            (async function* () {
                yield Buffer.from('Salut');
            })(),
        authorize: async () => (allowed ? { ok: true } : { ok: false, reason: 'not_granted' })
    });

    it('archive l’adresse au nom de son auteur', async () => {
        const {
            engine,
            job: row,
            finished
        } = engineFor({
            job,
            providers: { [MAILSERVER_BACKUP_PROVIDER]: mailOf(true) }
        });
        await engine.trigger(row, 5);
        const out = await finished;
        assert.equal(out.status, 'success', out.run.error ?? undefined);
        assert.match(out.run.artifact ?? '', /contact-exemple-fr-\d{8}-\d{6}\.tar\.gz$/);
        assert.ok(out.sizeBytes > 0);
    });

    it('un auteur qui ne gère plus les mots de passe de l’adresse arrête le travail', async () => {
        const {
            engine,
            job: row,
            finished
        } = engineFor({
            job,
            providers: { [MAILSERVER_BACKUP_PROVIDER]: mailOf(false) }
        });
        await engine.trigger(row, 5);
        assert.match(
            (await finished).run.error ?? '',
            /ne peut plus gérer les mots de passe de cette adresse \(la permission lui a été retirée\)/
        );
    });
});

describe('Backup : moteur, dossier hébergé', () => {
    it('archive l’arborescence par le contrat commun, et échoue sans le module', async () => {
        const job = { source_kind: 'hostingFolder', source_id: 4, content: JSON.stringify({ name: 'Site' }) };
        const hosting: TreeBackupProvider = {
            list: async () => [],
            find: async (id, workspaceId) =>
                id === 4 && workspaceId === 1 ? { id: 4, name: 'Site', workspaceId: 1, fileCount: 1, bytes: 5 } : null,
            entries: async () => [{ relPath: 'index.html', kind: 'file', size: 5, mtime: 1, mode: null, ref: '8' }],
            open: async () =>
                (async function* () {
                    yield Buffer.from('<p/>!');
                })()
        };
        const ok = engineFor({ job, providers: { [HOSTING_BACKUP_PROVIDER]: hosting } });
        await ok.engine.trigger(ok.job, 5);
        const out = await ok.finished;
        assert.equal(out.status, 'success', out.run.error ?? undefined);
        assert.match(out.run.artifact ?? '', /site-\d{8}-\d{6}\.tar\.gz$/);

        const bare = engineFor({ job });
        await bare.engine.trigger(bare.job, 5);
        assert.match((await bare.finished).run.error ?? '', /Hébergement indisponible : module non installé/);
    });
});
