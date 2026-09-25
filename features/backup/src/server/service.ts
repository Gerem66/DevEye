import crypto from 'crypto';
import type {
    BackupDestinationKind,
    BackupDestinationProbe,
    BackupDestinationRow,
    BackupJobRow,
    BackupRunRow
} from '../contracts/domain';

import {
    CLOUDSYNC_BACKUP_PROVIDER,
    DATABASE_BACKUP_PROVIDER,
    type CloudSyncBackupProvider,
    type DatabaseBackupProvider
} from '@deveye/types/sdk';
import { AGENT_FOLDER_ARCHIVE_PROBE } from '@deveye/types';
import type { FeatureService, FeatureServiceDeps, SdkAccessDenial, SdkCipher } from '@deveye/types/sdk/server';
import { backupKey, sealStream } from './crypto';
import { env } from './env';
import { buildNotice } from './notice';
import type { BackupRepo } from './repo';
import { nextRunAt } from './schedule';
import { SftpSink } from './sftp';
import { DeviceSink, LocalSink, S3Sink, type BackupSink } from './sinks';
import { cloudSyncSource, databaseSource, deveyeSource, deviceFolderSource, type BackupArtifact } from './sources';
import { WebDavSink } from './webdav';
import type { StoredDestination, StoredFolder, StoredJob, StoredRun } from './_shared';

/**
 * L'ordonnanceur des sauvegardes : un ticker du SDK qui cherche ce qui est dû
 * et le fait, sans session ni mot de passe (codec ouvert de l'espace, clé de
 * scellement dérivée de la clé serveur).
 *
 * Une sauvegarde dure, d'où : un travail à la fois (`running`), l'échéance
 * repoussée AVANT l'exécution (un travail qui plante ne repart pas en boucle),
 * l'exécution inscrite en base dès son début (`failStaleRuns` au démarrage).
 * Chemin d'une archive : source → gzip → [scellement] → destination, sans
 * passage par le disque.
 */

/** Combien de travaux dus on ramasse par tour. Borne la rafale, pas le débit. */
const DUE_BATCH = 20;

/** Pourquoi l'auteur d'un travail ne peut plus le faire tourner, en fin de phrase. */
const DENIALS: Record<SdkAccessDenial, string> = {
    not_member: 'il n’est plus membre de cet espace',
    suspended: 'son compte est suspendu',
    level: 'son rôle ne le permet plus',
    not_granted: 'la permission lui a été retirée',
    hidden: 'cet élément lui est fermé',
    read_only: 'cet élément est en lecture seule pour lui',
    no_device: 'la machine n’est plus dans cet espace'
};

/**
 * La destination est-elle un dossier de la même machine, sous le dossier
 * sauvegardé ? Son chemin relatif, pour l'exclure : sinon l'archive
 * s'avalerait elle-même à mesure qu'elle s'écrit. `''` quand c'est le dossier
 * même, qu'aucune exclusion ne sait écarter.
 */
export function destinationInside(source: string, destination: string): string | null {
    const windows = /^[A-Za-z]:/.test(source);
    const norm = (p: string): string => {
        const clean = p.replace(/\\/g, '/').replace(/\/+$/, '');
        return windows ? clean.toLowerCase() : clean;
    };
    const root = norm(source);
    const target = norm(destination);
    if (target === root) return '';
    const prefix = root === '' ? '/' : `${root}/`;
    if (!target.startsWith(prefix)) return null;
    // Le chemin tel qu'écrit, pas sa forme minuscule : l'agent compare à la lettre.
    return destination.replace(/\\/g, '/').replace(/\/+$/, '').slice(prefix.length);
}

export class BackupEngine {
    private readonly ticker: FeatureService;
    /** Travaux en cours d'exécution, pour qu'un même travail ne parte pas deux fois. */
    private readonly running = new Set<number>();
    private stopping = false;

    constructor(private readonly deps: FeatureServiceDeps<BackupRepo>) {
        this.ticker = deps.createTicker({ intervalMs: env.BACKUP_TICK_SECONDS * 1000, tick: () => this.tick() });
    }

    start(): void {
        this.stopping = false;
        // Solder ce qu'un arrêt brutal a laissé « en cours » : au-delà du budget
        // d'exécution, aucune exécution vivante ne peut porter ce statut.
        void this.deps.repo
            .failStaleRuns(Math.floor(Date.now() / 1000) - env.BACKUP_RUN_TIMEOUT_SECONDS)
            .then((n) => {
                if (n > 0) this.deps.logger.warn({ runs: n }, 'Backup: sauvegardes interrompues soldées au démarrage');
            })
            .catch((e: unknown) => this.deps.logger.error({ err: e }, 'Backup: solde des exécutions échoué'));

        this.ticker.start();
    }

    /**
     * Aucun travail dû ne part plus, mais une sauvegarde en cours n'est pas
     * attendue : elle dure jusqu'à des heures. Sa réservation et le seuil de
     * `failStaleRuns` la gardent d'un redémarrage rapproché.
     */
    stop(): void {
        this.stopping = true;
        void this.ticker.stop();
    }

    private cipherFor(workspaceId: number): SdkCipher {
        return this.deps.cipherFor(workspaceId);
    }

    private async tick(): Promise<void> {
        const now = Math.floor(Date.now() / 1000);
        const due = await this.deps.repo.listJobsDue(now, DUE_BATCH);
        for (const job of due) {
            if (this.stopping) break;
            // Séquentiel : cinq vidages en parallèle satureraient le lien montant
            // et la machine sauvegardée.
            await this.runJob(job, null).catch((e: unknown) =>
                this.deps.logger.error({ jobId: job.id, err: e }, 'Backup: exécution échouée')
            );
        }
    }

    /** Recalcule et enregistre l'échéance d'un travail. */
    async rescheduleJob(job: BackupJobRow, from: Date = new Date()): Promise<number | null> {
        const at = nextRunAt(
            job.schedule_kind as Parameters<typeof nextRunAt>[0],
            job.enabled === 1,
            job.schedule_hour,
            job.schedule_weekday,
            job.schedule_day,
            from
        );
        await this.deps.repo.setNextRun(job.id, at);
        return at;
    }

    /** Le contenu déchiffré d'une destination. */
    async readDestination(row: BackupDestinationRow): Promise<StoredDestination> {
        const raw = await this.cipherFor(row.workspace_id).tryDecrypt(row.content);
        const parsed = raw ? (JSON.parse(raw) as Partial<StoredDestination>) : {};
        return {
            name: parsed.name ?? 'Destination',
            path: parsed.path ?? '',
            endpoint: parsed.endpoint ?? null,
            region: parsed.region ?? null,
            bucket: parsed.bucket ?? null,
            accessKeyId: parsed.accessKeyId ?? null,
            host: parsed.host ?? null,
            port: parsed.port ?? null,
            username: parsed.username ?? null,
            sftpAuth: parsed.sftpAuth ?? null,
            hostKey: parsed.hostKey ?? null,
            lastError: parsed.lastError ?? null
        };
    }

    /**
     * L'écrivain d'une destination. Lève une phrase corrigeable : une
     * destination incomplète est une configuration, pas une panne.
     * `probing` : seul un contrôle peut faire connaissance d'un serveur SFTP.
     */
    async sinkFor(row: BackupDestinationRow, probing = false): Promise<BackupSink> {
        const stored = await this.readDestination(row);
        const kind = row.kind as BackupDestinationKind;
        const secret = async (): Promise<string | null> =>
            row.secret_enc ? await this.cipherFor(row.workspace_id).tryDecrypt(row.secret_enc) : null;

        switch (kind) {
            case 'local':
                return new LocalSink(row.workspace_id, stored.path);

            case 'device': {
                if (!row.device_id) {
                    throw new Error("Cette destination n'a plus d'appareil : l'appareil a été supprimé.");
                }
                const device = await this.deps.devices.find(row.device_id);
                if (!device) throw new Error("L'appareil de cette destination est introuvable.");
                return new DeviceSink(this.deps.agents, row.device_id, device.name, stored.path);
            }

            case 's3': {
                const key = await secret();
                if (!stored.endpoint || !stored.bucket || !stored.accessKeyId || !key) {
                    throw new Error(
                        'Cette destination S3 est incomplète : adresse, bucket, clé d’accès et clé secrète.'
                    );
                }
                return new S3Sink(
                    {
                        endpoint: stored.endpoint,
                        region: stored.region ?? 'us-east-1',
                        bucket: stored.bucket,
                        accessKeyId: stored.accessKeyId,
                        secretAccessKey: key,
                        pathStyle: row.path_style === 1
                    },
                    stored.path
                );
            }

            case 'sftp': {
                const credential = await secret();
                if (!stored.host || !stored.username || !stored.sftpAuth || !credential) {
                    throw new Error(
                        'Cette destination SFTP est incomplète : hôte, identifiant et mot de passe ou clé.'
                    );
                }
                return new SftpSink(
                    {
                        host: stored.host,
                        port: stored.port ?? 22,
                        username: stored.username,
                        auth: stored.sftpAuth,
                        secret: credential,
                        hostKey: stored.hostKey
                    },
                    stored.path,
                    probing
                );
            }

            case 'webdav': {
                const password = await secret();
                if (!stored.endpoint || !stored.username || !password) {
                    throw new Error('Cette destination WebDAV est incomplète : adresse, identifiant et mot de passe.');
                }
                return new WebDavSink({ url: stored.endpoint, username: stored.username, password }, stored.path);
            }

            default: {
                const unknown: never = kind;
                throw new Error(`Genre de destination inconnu : ${String(unknown)}`);
            }
        }
    }

    /** Contrôle une destination et enregistre le verdict. */
    async probeDestination(row: BackupDestinationRow): Promise<BackupDestinationProbe> {
        let probe: BackupDestinationProbe;
        let learnedHostKey: string | null = null;
        try {
            const sink = await this.sinkFor(row, true);
            probe = await sink.probe();
            // Le premier contrôle réussi fait connaissance : l'empreinte vue est retenue.
            if (probe.ok && sink instanceof SftpSink) learnedHostKey = sink.seenHostKey;
        } catch (e) {
            probe = { ok: false, error: (e as Error).message, usedBytes: null, freeBytes: null };
        }

        const stored = await this.readDestination(row);
        const content = await this.cipherFor(row.workspace_id).encrypt(
            JSON.stringify({
                ...stored,
                hostKey: stored.hostKey ?? learnedHostKey,
                lastError: probe.ok ? null : probe.error
            })
        );
        await this.deps.repo.recordDestinationProbe(
            row.id,
            Math.floor(Date.now() / 1000),
            probe.ok ? 'ok' : 'error',
            content
        );
        this.deps.live.changed(row.workspace_id);
        return probe;
    }

    /** Un travail est-il déjà en cours ? Ce que l'écran demande avant d'insister. */
    isRunning(jobId: number): boolean {
        return this.running.has(jobId);
    }

    /**
     * Ouvre une exécution et la lance en arrière-plan ; rend la ligne `running`
     * tout de suite, une sauvegarde durant des minutes.
     */
    async trigger(job: BackupJobRow, userId: number): Promise<BackupRunRow> {
        // Réservation **synchrone**, avant le premier `await` : deux clics
        // rapprochés (ou deux onglets) passeraient tous les deux un contrôle
        // placé après, et lanceraient deux vidages simultanés de la même base.
        if (!this.reserve(job.id)) throw new Error('Une sauvegarde de ce travail est déjà en cours.');
        try {
            const destination = await this.deps.repo.findDestinationForJob(job.id);
            if (!destination) throw new Error('La destination de ce travail est introuvable.');

            const run = await this.openRun(job, userId);
            void this.execute(job, destination, run).catch((e: unknown) =>
                this.deps.logger.error({ jobId: job.id, err: e }, 'Backup: exécution manuelle échouée')
            );
            return run;
        } catch (e) {
            // Rendue seulement si `execute` n'a pas pris le relais : c'est lui
            // qui relâche la réservation dans son `finally`.
            this.running.delete(job.id);
            throw e;
        }
    }

    /** Prend la réservation d'un travail. `false` s'il tourne déjà. */
    private reserve(jobId: number): boolean {
        if (this.running.has(jobId)) return false;
        this.running.add(jobId);
        return true;
    }

    /** Le chemin de l'ordonnanceur : échéance repoussée d'abord, exécution ensuite. */
    private async runJob(job: BackupJobRow, userId: number | null): Promise<void> {
        // AVANT toute chose, et même si l'exécution échoue derrière : c'est ce
        // qui empêche un travail cassé de repartir à chaque tour de boucle.
        await this.rescheduleJob(job);
        if (!this.reserve(job.id)) {
            this.deps.logger.warn({ jobId: job.id }, 'Backup: exécution précédente encore en cours, tour sauté');
            return;
        }
        const destination = await this.deps.repo.findDestinationForJob(job.id);
        if (!destination) {
            this.running.delete(job.id);
            this.deps.logger.error({ jobId: job.id }, 'Backup: destination introuvable');
            return;
        }
        const run = await this.openRun(job, userId);
        await this.execute(job, destination, run);
    }

    private async openRun(job: BackupJobRow, userId: number | null): Promise<BackupRunRow> {
        const content = await this.cipherFor(job.workspace_id).encrypt(
            JSON.stringify({ artifact: null, error: null } satisfies StoredRun)
        );
        const run = await this.deps.repo.startRun({
            jobId: job.id,
            workspaceId: job.workspace_id,
            encrypted: job.encryption === 'server',
            triggeredByUserId: userId,
            content
        });
        this.deps.live.changed(job.workspace_id);
        return run;
    }

    private async execute(job: BackupJobRow, destination: BackupDestinationRow, run: BackupRunRow): Promise<void> {
        const cipher = this.cipherFor(job.workspace_id);
        const started = Date.now();
        let storedJob: Partial<StoredJob> = {};
        try {
            storedJob = JSON.parse((await cipher.tryDecrypt(job.content)) ?? '{}') as Partial<StoredJob>;
        } catch {
            // Un intitulé illisible ne doit pas empêcher une sauvegarde : le
            // nom sert l'écran et le nom de fichier, jamais la mécanique.
        }
        const jobName = (storedJob.name ?? '').trim() || 'Sauvegarde';

        let artifact: string | null = null;
        let size = 0;
        let checksum: string | null = null;
        let error: string | null = null;
        let warning: string | null = null;
        // Le budget écoulé arrête la source, pas seulement l'attente.
        const abort = new AbortController();
        /**
         * `withTimeout` abandonne l'attente, pas le travail : la réservation ne
         * se relâche qu'à l'issue réelle de l'écriture, sinon le passage suivant
         * démarrerait par-dessus.
         */
        let writing: Promise<{ artifact: string; size: number }> | null = null;

        try {
            // Une destination « local » écrit sur le disque du serveur : l'offre
            // du propriétaire de l'espace la borne, comme CloudSync. Ce qui part
            // chez l'utilisateur (son appareil, son S3) ne lui coûte rien.
            // La taille de l'archive n'est pas connue d'avance : on refuse la
            // suivante une fois la limite franchie, pas celle qui la franchit.
            if (destination.kind === 'local') {
                await this.deps
                    .quotaFor(job.workspace_id)
                    // « +1 octet » : la taille de l'archive n'est pas connue
                    // d'avance, et une offre à zéro doit refuser dès la première.
                    .assert('storage', async (owned) => (await this.deps.repo.storedBytesInWorkspaces(owned)) + 1);
            }

            const source = await this.sourceFor(job, jobName, storedJob, destination, abort.signal);
            const sink = await this.sinkFor(destination);

            // Condensé du clair, avant scellement : deux scellements du même
            // clair donnent deux fichiers différents.
            const digest = crypto.createHash('sha256');
            const measured = async function* (input: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
                for await (const chunk of input) {
                    digest.update(chunk);
                    yield chunk;
                }
            };

            // La forme est celle du travail : la destination dit seulement où écrire.
            const sealed = job.encryption === 'server';
            const name = sealed ? `${source.name}.enc` : source.name;
            const body = sealed
                ? sealStream(backupKey(this.deps.keys), measured(source.stream))
                : measured(source.stream);

            writing = sink.write(name, body);
            const written = await this.withTimeout(writing, env.BACKUP_RUN_TIMEOUT_SECONDS * 1000, abort);
            artifact = written.artifact;
            size = written.size;
            checksum = digest.digest('hex');
            warning = source.warning?.() ?? null;
        } catch (e) {
            error = (e as Error).message;
        } finally {
            if (writing) {
                // `catch` avant `finally` : l'écriture a déjà été prise en compte
                // plus haut, et la laisser rejeter ici produirait un rejet non
                // traité qui, en production, tue le processus.
                void writing.catch(() => undefined).finally(() => this.running.delete(job.id));
            } else {
                this.running.delete(job.id);
            }
        }

        await this.deps.repo.finishRun(run.id, {
            status: error === null ? 'success' : 'failed',
            finishedAt: Math.floor(Date.now() / 1000),
            sizeBytes: size,
            checksum,
            content: await cipher.encrypt(JSON.stringify({ artifact, error, warning } satisfies StoredRun))
        });

        this.deps.audit({
            action: error === null ? 'backup.success' : 'backup.failure',
            level: error === null ? 'info' : 'error',
            userId: run.triggered_by_user_id ?? undefined,
            description:
                error === null
                    ? `Sauvegarde « ${jobName} » terminée (${formatBytes(size)})`
                    : `Sauvegarde « ${jobName} » en échec : ${error}`,
            metadata: {
                jobId: job.id,
                runId: run.id,
                workspaceId: job.workspace_id,
                artifact,
                elapsedMs: Date.now() - started
            }
        });

        if (error === null) await this.prune(job, destination);
        else await this.notifyFailure(job.workspace_id, job.id, jobName, error);

        this.deps.live.changed(job.workspace_id);
    }

    /** Ce que le travail sauvegarde, résolu au moment de l'exécution. */
    private async sourceFor(
        job: BackupJobRow,
        jobName: string,
        stored: Partial<StoredJob>,
        destination: BackupDestinationRow,
        signal: AbortSignal
    ): Promise<BackupArtifact> {
        if (job.source_kind === 'deveye') return deveyeSource();

        if (job.source_kind === 'deviceFolder') {
            if (!stored.folder) throw new Error('Ce travail ne dit plus quel dossier sauvegarder.');
            return this.deviceFolderFor(job, stored.folder, destination, signal);
        }

        if (job.source_kind === 'database') {
            if (!job.source_id) throw new Error('Ce travail ne désigne aucune base.');
            // L'accès (tunnel compris) est ouvert par Bases de données, seule à
            // savoir déchiffrer une connexion.
            const databases = this.deps.providers.get<DatabaseBackupProvider>(DATABASE_BACKUP_PROVIDER);
            if (!databases) throw new Error('Source Bases de données indisponible.');
            const access = await databases.openAccess(job.source_id, job.workspace_id);
            if (!access) throw new Error('La base de ce travail a été supprimée.');
            return databaseSource(access, jobName);
        }

        if (job.source_kind === 'cloudsync') {
            if (!job.source_id) throw new Error('Ce travail ne désigne aucun partage.');
            // Module absent : le run échoue proprement et reprendra quand il revient.
            const provider = this.deps.providers.get<CloudSyncBackupProvider>(CLOUDSYNC_BACKUP_PROVIDER);
            if (!provider) throw new Error('Source CloudSync indisponible : module non installé.');
            const share = await provider.findShare(job.source_id);
            if (!share || share.workspaceId !== job.workspace_id) {
                throw new Error('Le partage de ce travail a été supprimé.');
            }
            return cloudSyncSource(provider, { id: share.id, name: share.name }, this.deps.logger);
        }

        throw new Error(`Source de sauvegarde inconnue : ${job.source_kind}`);
    }

    /**
     * Le dossier d'une machine, au nom de l'auteur du travail : ses droits sont
     * relus à chaque passage, et le travail s'arrête le jour où il les perd.
     */
    private async deviceFolderFor(
        job: BackupJobRow,
        folder: StoredFolder,
        destination: BackupDestinationRow,
        signal: AbortSignal
    ): Promise<BackupArtifact> {
        const again = 'un membre autorisé doit enregistrer ce travail de nouveau.';
        const may = await this.deps.access.feature(job.workspace_id, folder.authorUserId, {
            level: 'write',
            extras: ['deviceFolders'],
            itemId: String(job.id)
        });
        if (!may.ok) {
            throw new Error(
                `L’auteur de ce travail ne peut plus sauvegarder les fichiers d’une machine (${DENIALS[may.reason]}) : ${again}`
            );
        }
        const files = await this.deps.access.device(job.workspace_id, folder.authorUserId, folder.deviceId, ['files']);
        if (!files.ok) {
            throw new Error(
                `L’auteur de ce travail n’a plus le droit Fichiers sur cette machine (${DENIALS[files.reason]}) : ${again}`
            );
        }

        const device = await this.deps.devices.find(folder.deviceId);
        if (!device) throw new Error('La machine de ce travail a été supprimée.');
        if (!this.deps.devices.isOnline(device.id)) throw new Error(`La machine « ${device.name} » est hors ligne.`);
        if (!device.report?.agent?.probes.includes(AGENT_FOLDER_ARCHIVE_PROBE)) {
            throw new Error(`L’agent de « ${device.name} » est à mettre à jour pour sauvegarder un dossier.`);
        }

        const exclusions = [...folder.exclusions];
        if (destination.kind === 'device' && destination.device_id === folder.deviceId) {
            const inside = destinationInside(folder.path, (await this.readDestination(destination)).path);
            if (inside === '') {
                throw new Error(
                    'Ce travail écrit ses archives dans le dossier même qu’il sauvegarde : choisissez une destination ailleurs.'
                );
            }
            if (inside !== null) exclusions.push({ kind: 'path', pattern: inside });
        }
        return deviceFolderSource(
            this.deps.agents,
            device,
            { path: folder.path, exclusions, oneFileSystem: folder.oneFileSystem },
            signal
        );
    }

    /**
     * Rétention : au-delà de `keep_last` réussites, la plus ancienne part. Une
     * archive qu'on n'arrive pas à effacer reste marquée présente : la
     * rétention repassera.
     */
    private async prune(job: BackupJobRow, destination: BackupDestinationRow): Promise<void> {
        await this.erase(job, destination, await this.deps.repo.listRunsToPrune(job.id, job.keep_last));
    }

    /**
     * Efface l'archive de chaque exécution à sa destination, puis la marque
     * effacée : elle ne compte plus au stockage. Rend combien n'ont pas pu
     * l'être, qui restent présentes et comptées.
     */
    async erase(job: BackupJobRow, destination: BackupDestinationRow, runs: readonly BackupRunRow[]): Promise<number> {
        if (runs.length === 0) return 0;

        const cipher = this.cipherFor(job.workspace_id);
        let sink: BackupSink;
        try {
            sink = await this.sinkFor(destination);
        } catch (e) {
            this.deps.logger.warn({ jobId: job.id, err: (e as Error).message }, 'Backup: effacement reporté');
            return runs.length;
        }

        let failed = 0;
        for (const run of runs) {
            let stored: StoredRun;
            try {
                stored = JSON.parse((await cipher.tryDecrypt(run.content)) ?? '{}') as StoredRun;
            } catch {
                failed++;
                continue;
            }
            if (!stored.artifact) {
                // Rien à effacer : la ligne n'a jamais porté d'archive.
                await this.deps.repo.markPruned(run.id);
                continue;
            }
            try {
                await sink.remove(stored.artifact);
                await this.deps.repo.markPruned(run.id);
            } catch (e) {
                failed++;
                this.deps.logger.warn(
                    { jobId: job.id, runId: run.id, err: (e as Error).message },
                    'Backup: archive non effacée, réessai au prochain passage'
                );
            }
        }
        return failed;
    }

    private async notifyFailure(
        workspaceId: number,
        // Sa route l'emporte sur celle de la feature : une sauvegarde critique
        // peut réveiller quelqu'un d'autre.
        jobId: number,
        jobName: string,
        error: string
    ): Promise<void> {
        try {
            await this.deps.deveyeFor(workspaceId).notify.send(
                {
                    subject: `DevEye : sauvegarde « ${jobName} » en échec`,
                    body: `La sauvegarde « ${jobName} » a échoué.\n\n${error}`,
                    payload: { feature: 'backup', job: jobName, error },
                    // Seuls les échecs sont annoncés : un canal rempli de succès
                    // noierait celui qui compte.
                    embeds: buildNotice({
                        job: jobName,
                        destination: null,
                        error,
                        at: Math.floor(Date.now() / 1000)
                    })
                },
                { itemId: jobId }
            );
        } catch (e) {
            this.deps.logger.error({ err: e }, "Backup: envoi de l'avis d'échec impossible");
        }
    }

    /**
     * Sans borne, un agent muet au milieu d'un dépôt laisserait le travail dans
     * `running` pour toujours. L'échéance déclenche `abort` : une source qui
     * l'écoute s'arrête, au lieu de continuer pour personne.
     */
    private async withTimeout<T>(promise: Promise<T>, ms: number, abort: AbortController): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            return await Promise.race([
                promise,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        const reason = new Error(`Sauvegarde abandonnée après ${Math.round(ms / 60000)} minutes.`);
                        abort.abort(reason);
                        reject(reason);
                    }, ms);
                    timer.unref();
                })
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}

/** Une taille lisible, pour les journaux et les avis. */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} o`;
    const units = ['Kio', 'Mio', 'Gio', 'Tio'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
