import crypto from 'crypto';
import type { Logger } from 'pino';
import type {
    BackupDestinationProbe,
    BackupDestinationRow,
    BackupJobRow,
    BackupRunRow,
    BackupScheduleKind
} from 'deveye-types';

import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';
import type { LiveHub } from '@/live/hub';
import type { MonitorHub } from '@/agent/hub';
import { CLOUDSYNC_BACKUP_PROVIDER, type CloudSyncBackupProvider } from 'deveye-types/sdk';
import { moduleProvider } from '@/features/_sdk/register';
import type { AuditLog } from '@/Services/AuditLog';
import type { DatabaseMonitor } from '@/Services/DatabaseMonitor';
import { createOpenCipher, type Cipher } from '@/Services/SecureStore';
import { deliver, hasChannel, resolveRoute } from '@/Services/notifications';
import { buildNotice } from '@/Services/notices/backup';
import { env } from '@/Utils/Env';
import { backupKey, sealStream } from '@/backup/crypto';
import { DeviceSink, LocalSink, S3Sink, type BackupSink } from '@/backup/sinks';
import { cloudSyncSource, databaseSource, deveyeSource, type BackupArtifact } from '@/backup/sources';

/**
 * L'ordonnanceur des sauvegardes, et le moteur qui les exécute.
 *
 * Même forme que `UptimeMonitor` et `DatabaseMonitor` : une boucle `setInterval`
 * démarrée par `index.ts`, qui cherche ce qui est dû et le fait. Pas de file de
 * messages, pas de cron — pour la même raison que partout ailleurs ici : un seul
 * processus écrit, et une dépendance de plus au démarrage serait une panne de
 * plus au démarrage.
 *
 * ## Ce qui rend ce service différent des quatre autres
 *
 * Une sauvegarde **dure**. Un relevé Uptime prend une seconde, un vidage de base
 * peut prendre une heure. Trois conséquences structurelles :
 *
 *  1. **un travail à la fois par espace** (`running`) — deux vidages simultanés
 *     de la même base doubleraient la charge sur un serveur de production pour
 *     produire deux archives identiques ;
 *  2. **l'échéance est repoussée AVANT l'exécution**, jamais après. Un travail
 *     qui plante ne doit pas repartir au tour suivant, en boucle, en écrivant
 *     des archives ratées jusqu'à saturer la destination ;
 *  3. **l'exécution est inscrite en base dès son début** (`running`), pour que
 *     l'écran montre ce qui se passe pendant que ça se passe — et pour que la
 *     mort du processus laisse une trace au lieu d'un silence
 *     (`failStaleRuns` au démarrage).
 *
 * ## Le chemin d'une archive
 *
 *     source → gzip → [scellement] → destination
 *
 * Rien n'est jamais posé sur disque entre les deux bouts. Voir
 * `backup/sources.ts` pour les producteurs, `backup/sinks.ts` pour les
 * destinations, `backup/crypto.ts` pour le scellement.
 */

interface BackupDeps {
    db: Database;
    crypt: Encryption;
    hub: MonitorHub;
    databases: DatabaseMonitor;
    audit: AuditLog;
    logger: Logger;
    live?: LiveHub;
}

/** Ce que `content` porte, chiffré, sur une destination. */
export interface StoredDestination {
    name: string;
    path: string;
    endpoint: string | null;
    region: string | null;
    bucket: string | null;
    accessKeyId: string | null;
    lastError: string | null;
}

/** Ce que `content` porte, chiffré, sur un travail. */
export interface StoredJob {
    name: string;
}

/** Ce que `content` porte, chiffré, sur une exécution. */
export interface StoredRun {
    artifact: string | null;
    error: string | null;
}

/** Combien de travaux dus on ramasse par tour. Borne la rafale, pas le débit. */
const DUE_BATCH = 20;

export class BackupService {
    private timer: ReturnType<typeof setInterval> | null = null;
    private ticking = false;
    /** Travaux en cours d'exécution, pour qu'un même travail ne parte pas deux fois. */
    private readonly running = new Set<number>();
    private readonly ciphers = new Map<number, Cipher>();

    constructor(private readonly deps: BackupDeps) {}

    start(): void {
        if (this.timer) return;
        // Solder ce qu'un arrêt brutal a laissé « en cours ». La borne est
        // l'échéance d'exécution : au-delà, plus aucune exécution vivante ne
        // peut légitimement porter ce statut.
        void this.deps.db.backup
            .failStaleRuns(Math.floor(Date.now() / 1000) - env.BACKUP_RUN_TIMEOUT_SECONDS)
            .then((n) => {
                if (n > 0) this.deps.logger.warn({ runs: n }, 'Backup: sauvegardes interrompues soldées au démarrage');
            })
            .catch((e: unknown) => this.deps.logger.error({ err: e }, 'Backup: solde des exécutions échoué'));

        this.timer = setInterval(() => void this.tick(), env.BACKUP_TICK_SECONDS * 1000);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private cipherFor(workspaceId: number): Cipher {
        let cipher = this.ciphers.get(workspaceId);
        if (!cipher) {
            cipher = createOpenCipher(this.deps.db, this.deps.crypt, workspaceId);
            this.ciphers.set(workspaceId, cipher);
        }
        return cipher;
    }

    private async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try {
            const now = Math.floor(Date.now() / 1000);
            const due = await this.deps.db.backup.listJobsDue(now, DUE_BATCH);
            for (const job of due) {
                // Séquentiel, et c'est voulu : lancer cinq vidages en parallèle
                // saturerait le lien montant et la machine sauvegardée. La
                // sauvegarde est le travail de fond qui doit le moins déranger.
                await this.runJob(job, null).catch((e: unknown) =>
                    this.deps.logger.error({ jobId: job.id, err: e }, 'Backup: exécution échouée')
                );
            }
        } catch (e) {
            this.deps.logger.error({ err: e }, 'Backup: tour de boucle échoué');
        } finally {
            this.ticking = false;
        }
    }

    /**
     * La prochaine échéance d'un travail, à partir de `from`.
     *
     * Rend `null` pour un travail manuel ou désactivé : c'est ce `NULL` qui le
     * sort de l'index des travaux dus, plutôt qu'une condition de plus dans la
     * requête chaude.
     *
     * Les heures sont **locales au serveur** : « sauvegarde à 3 h » veut dire
     * 3 h là où la machine est administrée, pas 3 h UTC. Le passage à l'heure
     * d'été décale donc une sauvegarde d'une heure une fois par an, ce qui est
     * exactement ce qu'on veut ici et le contraire de ce qu'on voudrait pour une
     * mesure.
     */
    static nextRunAt(
        schedule: BackupScheduleKind,
        enabled: boolean,
        hour: number,
        weekday: number,
        day: number,
        from: Date = new Date()
    ): number | null {
        if (!enabled || schedule === 'manual') return null;

        const next = new Date(from.getTime());
        next.setSeconds(0, 0);

        if (schedule === 'hourly') {
            next.setMinutes(0);
            next.setTime(next.getTime() + 60 * 60 * 1000);
            return Math.floor(next.getTime() / 1000);
        }

        next.setMinutes(0);
        next.setHours(hour);
        // Toujours strictement dans le futur : sans ce test, enregistrer un
        // travail à 3 h 00 min 30 s le ferait partir immédiatement, puis
        // repartir le lendemain — un déclenchement fantôme à chaque édition.
        const advanceDay = (): void => {
            next.setDate(next.getDate() + 1);
        };
        if (next.getTime() <= from.getTime()) advanceDay();

        if (schedule === 'daily') return Math.floor(next.getTime() / 1000);

        if (schedule === 'weekly') {
            while (next.getDay() !== weekday) advanceDay();
            return Math.floor(next.getTime() / 1000);
        }

        // Mensuel. `day` est borné à 28 par le contrat, donc ce quantième
        // existe tous les mois et la boucle se termine en au plus 31 pas.
        while (next.getDate() !== day) advanceDay();
        return Math.floor(next.getTime() / 1000);
    }

    /** Recalcule et enregistre l'échéance d'un travail. */
    async rescheduleJob(job: BackupJobRow, from: Date = new Date()): Promise<number | null> {
        const at = BackupService.nextRunAt(
            job.schedule_kind as BackupScheduleKind,
            job.enabled === 1,
            job.schedule_hour,
            job.schedule_weekday,
            job.schedule_day,
            from
        );
        await this.deps.db.backup.setNextRun(job.id, at);
        return at;
    }

    // ------------------------------------------------------------ destinations

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
            lastError: parsed.lastError ?? null
        };
    }

    /**
     * Construit l'écrivain d'une destination.
     *
     * Lève une phrase corrigeable plutôt qu'un `undefined` plus loin : une
     * destination S3 sans bucket ou une destination d'appareil dont la machine a
     * été supprimée sont des configurations incomplètes, pas des pannes.
     */
    async sinkFor(row: BackupDestinationRow): Promise<BackupSink> {
        const stored = await this.readDestination(row);

        if (row.kind === 'local') return new LocalSink(row.workspace_id, stored.path);

        if (row.kind === 'device') {
            if (!row.device_id) {
                throw new Error("Cette destination n'a plus d'appareil : l'appareil a été supprimé.");
            }
            const device = await this.deps.db.devices.findById(row.device_id);
            if (!device) throw new Error("L'appareil de cette destination est introuvable.");
            return new DeviceSink(this.deps.hub, row.device_id, device.name, stored.path);
        }

        const secret = row.secret_enc ? await this.cipherFor(row.workspace_id).tryDecrypt(row.secret_enc) : null;
        if (!stored.endpoint || !stored.bucket || !stored.accessKeyId || !secret) {
            throw new Error('Cette destination S3 est incomplète : adresse, bucket, clé d’accès et clé secrète.');
        }
        return new S3Sink(
            {
                endpoint: stored.endpoint,
                region: stored.region ?? 'us-east-1',
                bucket: stored.bucket,
                accessKeyId: stored.accessKeyId,
                secretAccessKey: secret,
                pathStyle: row.path_style === 1
            },
            stored.path
        );
    }

    /** Contrôle une destination et enregistre le verdict. */
    async probeDestination(row: BackupDestinationRow): Promise<BackupDestinationProbe> {
        let probe: BackupDestinationProbe;
        try {
            probe = await (await this.sinkFor(row)).probe();
        } catch (e) {
            probe = { ok: false, error: (e as Error).message, usedBytes: null, freeBytes: null };
        }

        const stored = await this.readDestination(row);
        const content = await this.cipherFor(row.workspace_id).encrypt(
            JSON.stringify({ ...stored, lastError: probe.ok ? null : probe.error })
        );
        await this.deps.db.backup.recordDestinationProbe(
            row.id,
            Math.floor(Date.now() / 1000),
            probe.ok ? 'ok' : 'error',
            content
        );
        this.deps.live?.changed(row.workspace_id, ['backup'], null);
        return probe;
    }

    // ---------------------------------------------------------------- exécution

    /** Un travail est-il déjà en cours ? Ce que l'écran demande avant d'insister. */
    isRunning(jobId: number): boolean {
        return this.running.has(jobId);
    }

    /**
     * Ouvre une exécution et la lance en arrière-plan.
     *
     * Rend la ligne `running` tout de suite : une sauvegarde dure des minutes, et
     * attendre la réponse d'une commande WebSocket pendant ce temps-là ne
     * marcherait pas. L'écran suit par re-sollicitation, comme partout ailleurs.
     */
    async trigger(job: BackupJobRow, userId: number): Promise<BackupRunRow> {
        // Réservation **synchrone**, avant le premier `await` : deux clics
        // rapprochés — ou deux onglets — passeraient tous les deux un contrôle
        // placé après, et lanceraient deux vidages simultanés de la même base.
        if (!this.reserve(job.id)) throw new Error('Une sauvegarde de ce travail est déjà en cours.');
        try {
            const destination = await this.deps.db.backup.findDestinationForJob(job.id);
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
        const destination = await this.deps.db.backup.findDestinationForJob(job.id);
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
        const run = await this.deps.db.backup.startRun({
            jobId: job.id,
            workspaceId: job.workspace_id,
            encrypted: job.encryption === 'server',
            triggeredByUserId: userId,
            content
        });
        this.deps.live?.changed(job.workspace_id, ['backup'], null);
        return run;
    }

    private async execute(job: BackupJobRow, destination: BackupDestinationRow, run: BackupRunRow): Promise<void> {
        const cipher = this.cipherFor(job.workspace_id);
        const started = Date.now();
        let jobName = 'Sauvegarde';
        try {
            jobName = ((JSON.parse((await cipher.tryDecrypt(job.content)) ?? '{}') as StoredJob).name ?? '').trim();
        } catch {
            // Un intitulé illisible ne doit pas empêcher une sauvegarde : le
            // nom sert l'écran et le nom de fichier, jamais la mécanique.
        }
        if (jobName === '') jobName = 'Sauvegarde';

        let artifact: string | null = null;
        let size = 0;
        let checksum: string | null = null;
        let error: string | null = null;
        /**
         * L'écriture réellement en cours, distincte de ce qu'on attend.
         *
         * `withTimeout` **abandonne l'attente, pas le travail** : une écriture
         * qui dépasse le budget continue de pousser des octets en arrière-plan.
         * Relâcher la réservation à ce moment-là laisserait le passage suivant
         * démarrer par-dessus, et deux vidages de la même base se disputeraient
         * la même destination. On ne la relâche donc qu'à l'issue *réelle*.
         */
        let writing: Promise<{ artifact: string; size: number }> | null = null;

        try {
            const source = await this.sourceFor(job, jobName);
            const sink = await this.sinkFor(destination);

            // Le condensé est calculé **sur le clair**, avant scellement : c'est
            // lui qui permettra de vérifier une restauration, et le condensé du
            // chiffré ne dirait rien (deux scellements du même clair donnent deux
            // fichiers différents).
            const digest = crypto.createHash('sha256');
            const measured = async function* (input: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
                for await (const chunk of input) {
                    digest.update(chunk);
                    yield chunk;
                }
            };

            // La forme est celle du TRAVAIL (094) : la destination dit où
            // écrire, le travail dit sous quelle forme.
            const sealed = job.encryption === 'server';
            const name = sealed ? `${source.name}.enc` : source.name;
            const body = sealed
                ? sealStream(backupKey(this.deps.crypt), measured(source.stream))
                : measured(source.stream);

            writing = sink.write(name, body);
            const written = await this.withTimeout(writing, env.BACKUP_RUN_TIMEOUT_SECONDS * 1000);
            artifact = written.artifact;
            size = written.size;
            checksum = digest.digest('hex');
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

        await this.deps.db.backup.finishRun(run.id, {
            status: error === null ? 'success' : 'failed',
            finishedAt: Math.floor(Date.now() / 1000),
            sizeBytes: size,
            checksum,
            content: await cipher.encrypt(JSON.stringify({ artifact, error } satisfies StoredRun))
        });

        this.deps.audit.record({
            source: 'system',
            category: 'backup',
            action: error === null ? 'backup.success' : 'backup.failure',
            level: error === null ? 'info' : 'error',
            uid: run.triggered_by_user_id ?? 0,
            ip: '',
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

        this.deps.live?.changed(job.workspace_id, ['backup'], null);
    }

    /** Ce que le travail sauvegarde, résolu au moment de l'exécution. */
    private async sourceFor(job: BackupJobRow, jobName: string): Promise<BackupArtifact> {
        if (job.source_kind === 'deveye') return deveyeSource();

        if (job.source_kind === 'database') {
            if (!job.source_id) throw new Error('Ce travail ne désigne aucune base.');
            const row = await this.deps.db.databases.find(job.source_id, job.workspace_id);
            if (!row) throw new Error('La base de ce travail a été supprimée.');
            const target = await this.deps.databases.targetOf(row, job.workspace_id);
            return databaseSource(target, jobName);
        }

        if (job.source_kind === 'cloudsync') {
            if (!job.source_id) throw new Error('Ce travail ne désigne aucun partage.');
            // CloudSync est un module : la lecture des partages passe par le
            // contrat qu'il offre. Absent, le run échoue proprement et
            // reprendra le jour où le module revient.
            const provider = moduleProvider<CloudSyncBackupProvider>(CLOUDSYNC_BACKUP_PROVIDER);
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
     * Applique la rétention : au-delà de `keep_last` archives réussies, la plus
     * ancienne part.
     *
     * Une archive qu'on n'arrive pas à effacer (appareil hors ligne, droit
     * manquant) **reste marquée présente** : la rétention repassera. La marquer
     * effacée alors qu'elle ne l'est pas ferait grossir la destination sans que
     * rien ne le dise, ce qui est la panne qu'on découvre quand le disque est
     * plein.
     */
    private async prune(job: BackupJobRow, destination: BackupDestinationRow): Promise<void> {
        const stale = await this.deps.db.backup.listRunsToPrune(job.id, job.keep_last);
        if (stale.length === 0) return;

        const cipher = this.cipherFor(job.workspace_id);
        let sink: BackupSink;
        try {
            sink = await this.sinkFor(destination);
        } catch (e) {
            this.deps.logger.warn({ jobId: job.id, err: (e as Error).message }, 'Backup: rétention reportée');
            return;
        }

        for (const old of stale) {
            let stored: StoredRun;
            try {
                stored = JSON.parse((await cipher.tryDecrypt(old.content)) ?? '{}') as StoredRun;
            } catch {
                continue;
            }
            if (!stored.artifact) {
                // Rien à effacer : la ligne n'a jamais porté d'archive.
                await this.deps.db.backup.markPruned(old.id);
                continue;
            }
            try {
                await sink.remove(stored.artifact);
                await this.deps.db.backup.markPruned(old.id);
            } catch (e) {
                this.deps.logger.warn(
                    { jobId: job.id, runId: old.id, err: (e as Error).message },
                    'Backup: archive non effacée, réessai au prochain passage'
                );
            }
        }
    }

    private async notifyFailure(
        workspaceId: number,
        // Le travail concerné : sa route l'emporte sur celle de la
        // fonctionnalité, de sorte qu'une sauvegarde critique puisse réveiller
        // quelqu'un d'autre que les copies de routine.
        jobId: number,
        jobName: string,
        error: string
    ): Promise<void> {
        try {
            const channels = await resolveRoute(
                this.deps.db,
                this.cipherFor(workspaceId),
                workspaceId,
                'backup',
                jobId
            );
            if (!hasChannel(channels)) return;
            await deliver(
                channels,
                {
                    subject: `DevEye — sauvegarde « ${jobName} » en échec`,
                    body: `La sauvegarde « ${jobName} » a échoué.\n\n${error}`,
                    payload: { feature: 'backup', job: jobName, error },
                    // La même alerte, mise en page pour Discord. Seuls les
                    // échecs sont annoncés : un canal rempli de succès
                    // quotidiens finirait par noyer celui qui compte.
                    embeds: buildNotice({
                        job: jobName,
                        destination: null,
                        error,
                        at: Math.floor(Date.now() / 1000)
                    })
                },
                this.deps.logger
            );
        } catch (e) {
            this.deps.logger.error({ err: e }, "Backup: envoi de l'avis d'échec impossible");
        }
    }

    /**
     * Borne une exécution.
     *
     * Sans elle, un agent qui cesse de répondre au milieu d'un dépôt laisserait
     * le travail dans `running` pour toujours — et donc tous ses passages
     * suivants sautés en silence.
     */
    private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            return await Promise.race([
                promise,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(`Sauvegarde abandonnée après ${Math.round(ms / 60000)} minutes.`)),
                        ms
                    );
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
