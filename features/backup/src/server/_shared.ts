import type {
    BackupDestination,
    BackupFolder,
    BackupDestinationKind,
    BackupDestinationRow,
    BackupDestinationStatus,
    BackupDestinationWithUsageRow,
    BackupJob,
    BackupJobWithStateRow,
    BackupRun,
    BackupRunRow,
    BackupRunStatus,
    BackupScheduleKind,
    BackupSftpAuth,
    BackupSourceKind,
    BackupVolume
} from '../contracts/domain';

import {
    CLOUDSYNC_BACKUP_PROVIDER,
    DATABASE_BACKUP_PROVIDER,
    HOSTING_BACKUP_PROVIDER,
    MAILSERVER_BACKUP_PROVIDER,
    type DatabaseBackupProvider,
    type MailServerBackupProvider,
    type TreeBackupProvider
} from '@deveye/types/sdk';
import { FeatureError, type SdkCipher, type SdkFeatureContext, type SdkShareScope } from '@deveye/types/sdk/server';

import type { BackupEngine } from './service';
import type { BackupRepo } from './repo';

/**
 * Ce que les handlers partagent : gardes d'accès, lecture du chiffré,
 * projection des lignes vers les DTO. Aucun verrou de session : tout vit à
 * l'étage ouvert.
 */

export type Ctx = SdkFeatureContext<BackupRepo>;

/** Ce que `content` porte, chiffré, sur une destination. */
export interface StoredDestination {
    name: string;
    path: string;
    endpoint: string | null;
    region: string | null;
    bucket: string | null;
    accessKeyId: string | null;
    host: string | null;
    port: number | null;
    username: string | null;
    sftpAuth: BackupSftpAuth | null;
    /** L'empreinte SFTP retenue au premier contrôle réussi. */
    hostKey: string | null;
    lastError: string | null;
}

/**
 * Le dossier d'un travail `deviceFolder`, et le membre au nom de qui il
 * s'exécute : c'est de ses droits que le travail tient les siens.
 */
export interface StoredFolder extends BackupFolder {
    authorUserId: number;
}

/** Ce que `content` porte, chiffré, sur un travail. */
export interface StoredJob {
    name: string;
    folder?: StoredFolder;
    volume?: BackupVolume;
    /** L'auteur d'un travail `dockerVolume` ou `mailbox` ; celui d'un dossier est dans `folder`. */
    authorUserId?: number;
}

/** Le membre au nom de qui le travail s'exécute, quand sa source en exige un. */
export const authorOf = (job: Partial<StoredJob>): number | null =>
    job.folder?.authorUserId ?? job.authorUserId ?? null;

/** Ce que `content` porte, chiffré, sur une exécution. */
export interface StoredRun {
    artifact: string | null;
    error: string | null;
    warning?: string | null;
}

/** Le moteur, posé par `createService` au démarrage : unique par processus. */
let engineRef: BackupEngine | null = null;

export function setEngine(engine: BackupEngine | null): void {
    engineRef = engine;
}

/** Le moteur est absent uniquement avant le start du service : toute commande qui exécute l'exige. */
export function requireEngine(): BackupEngine {
    if (!engineRef) throw new FeatureError('internal', 'Le moteur de sauvegardes est indisponible.');
    return engineRef;
}

/** Lit un blob JSON chiffré, en tolérant l'illisible (liste dégradée, pas vide). */
export async function readJson<T>(ctx: Ctx, blob: string): Promise<Partial<T>> {
    return readJsonWith<T>(ctx.cipher(), blob);
}

/** La même lecture, sous un codec explicite : celui du domicile d'une ligne projetée. */
export async function readJsonWith<T>(cipher: SdkCipher, blob: string): Promise<Partial<T>> {
    if (!blob) return {};
    try {
        const raw = await cipher.tryDecrypt(blob);
        return raw ? (JSON.parse(raw) as Partial<T>) : {};
    } catch {
        return {};
    }
}

/** Les contrats consommés, relus à l'appel : chacun peut être absent. */
export function databaseProvider(ctx: Pick<Ctx, 'providers'>): DatabaseBackupProvider | undefined {
    return ctx.providers.get<DatabaseBackupProvider>(DATABASE_BACKUP_PROVIDER);
}

export function mailProvider(ctx: Pick<Ctx, 'providers'>): MailServerBackupProvider | undefined {
    return ctx.providers.get<MailServerBackupProvider>(MAILSERVER_BACKUP_PROVIDER);
}

/** Les sources en arborescence, et le contrat qui sert chacune. */
export type TreeSourceKind = 'cloudsync' | 'hostingFolder';

export const TREE_PROVIDERS: Record<TreeSourceKind, string> = {
    cloudsync: CLOUDSYNC_BACKUP_PROVIDER,
    hostingFolder: HOSTING_BACKUP_PROVIDER
};

export const isTreeKind = (kind: BackupSourceKind): kind is TreeSourceKind => kind in TREE_PROVIDERS;

export function treeProvider(ctx: Pick<Ctx, 'providers'>, kind: TreeSourceKind): TreeBackupProvider | undefined {
    return ctx.providers.get<TreeBackupProvider>(TREE_PROVIDERS[kind]);
}

export async function loadDestination(ctx: Ctx, destinationId: number): Promise<BackupDestinationRow> {
    const row = await ctx.repo.findDestination(destinationId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Destination introuvable');
    return row;
}

/**
 * Un travail visible depuis cet espace, le sien ou un que l'on y projette.
 * `level` décide de la garde : `items.assert` refuse en plus les travaux
 * qu'une restriction de rôle masque ou passe en lecture seule.
 */
export async function loadJob(ctx: Ctx, jobId: number, level: 'read' | 'write' = 'read') {
    const row = await ctx.repo.findVisibleJob(jobId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Travail de sauvegarde introuvable');
    await ctx.items.assert(String(jobId), level);
    return row;
}

/** Comme {@link loadJob}, mais exige le domicile : modifier et supprimer se font chez lui. */
export async function loadHomeJob(ctx: Ctx, jobId: number) {
    const row = await loadJob(ctx, jobId, 'write');
    if (row.workspace_id !== ctx.workspaceId) {
        throw new FeatureError(
            'forbidden',
            'Ce travail appartient à un autre espace : il se modifie et se supprime depuis là-bas.'
        );
    }
    return row;
}

export async function toDestination(ctx: Ctx, row: BackupDestinationWithUsageRow): Promise<BackupDestination> {
    const stored = await readJson<StoredDestination>(ctx, row.content);
    return {
        id: row.id,
        kind: row.kind as BackupDestinationKind,
        name: stored.name ?? 'Destination',
        deviceId: row.device_id,
        deviceName: row.device_name,
        path: stored.path ?? '',
        endpoint: stored.endpoint ?? null,
        region: stored.region ?? null,
        bucket: stored.bucket ?? null,
        accessKeyId: stored.accessKeyId ?? null,
        host: stored.host ?? null,
        port: stored.port ?? null,
        username: stored.username ?? null,
        sftpAuth: stored.sftpAuth ?? null,
        hostKey: stored.hostKey ?? null,
        // Le secret ne sort jamais.
        hasSecret: row.secret_enc.length > 0,
        pathStyle: row.path_style === 1,
        status: row.status as BackupDestinationStatus,
        lastError: stored.lastError ?? null,
        checkedAt: row.checked_at,
        jobCount: Number(row.job_count ?? 0),
        created: row.created
    };
}

/** Les noms d'une requête, lus une fois pour toute une liste de travaux. */
const memberNames = new WeakMap<Ctx, Promise<Map<number, string>>>();
const deviceNames = new WeakMap<Ctx, Promise<Map<string, string>>>();

function memberNamesOf(ctx: Ctx): Promise<Map<number, string>> {
    let names = memberNames.get(ctx);
    if (!names) {
        names = ctx.deveye.members
            .list()
            .then((members) => new Map(members.map((m) => [m.userId, m.name])))
            .catch(() => new Map());
        memberNames.set(ctx, names);
    }
    return names;
}

function deviceNamesOf(ctx: Ctx): Promise<Map<string, string>> {
    let names = deviceNames.get(ctx);
    if (!names) {
        names = ctx.deveye.devices
            .list()
            .then((devices) => new Map(devices.map((d) => [d.id, d.name])))
            .catch(() => new Map());
        deviceNames.set(ctx, names);
    }
    return names;
}

export async function toJob(ctx: Ctx, row: BackupJobWithStateRow, shares?: SdkShareScope): Promise<BackupJob> {
    // Le codec du **domicile** de la ligne : un travail projeté, et tout ce qui
    // pend à lui, sa destination, sa dernière erreur, reste chiffré sous la clé
    // de son espace d'origine.
    const cipher = shares ? await shares.cipherFor(String(row.id)) : ctx.cipher();
    const [job, destination] = await Promise.all([
        readJsonWith<StoredJob>(cipher, row.content),
        readJsonWith<StoredDestination>(cipher, row.destination_content)
    ]);
    const lastRun = row.last_run_content ? await readJsonWith<StoredRun>(cipher, row.last_run_content) : {};
    const authorUserId = authorOf(job);
    const deviceNameOf = async (deviceId: string): Promise<string | null> =>
        (await deviceNamesOf(ctx)).get(deviceId) ?? null;

    return {
        foreign: row.workspace_id !== ctx.workspaceId,
        id: row.id,
        name: job.name ?? 'Sauvegarde',
        enabled: row.enabled === 1,
        encryption: row.encryption === 'none' ? 'none' : 'server',
        destinationId: row.destination_id,
        destinationName: destination.name ?? 'Destination',
        destinationKind: row.destination_kind as BackupDestinationKind,
        source: row.source_kind as BackupSourceKind,
        sourceId: row.source_id,
        sourceName: await sourceNameOf(ctx, row.source_kind as BackupSourceKind, row.source_id, row.workspace_id, job),
        folder: job.folder
            ? {
                  deviceId: job.folder.deviceId,
                  path: job.folder.path,
                  exclusions: job.folder.exclusions,
                  oneFileSystem: job.folder.oneFileSystem,
                  deviceName: await deviceNameOf(job.folder.deviceId)
              }
            : null,
        volume: job.volume
            ? {
                  deviceId: job.volume.deviceId,
                  engine: job.volume.engine,
                  name: job.volume.name,
                  deviceName: await deviceNameOf(job.volume.deviceId)
              }
            : null,
        author:
            authorUserId === null
                ? null
                : { userId: authorUserId, name: (await memberNamesOf(ctx)).get(authorUserId) ?? null },
        schedule: row.schedule_kind as BackupScheduleKind,
        scheduleHour: row.schedule_hour,
        scheduleWeekday: row.schedule_weekday,
        scheduleDay: row.schedule_day,
        keepLast: row.keep_last,
        nextRunAt: row.next_run_at,
        lastRunAt: row.last_run_at,
        lastStatus: (row.last_status as BackupRunStatus | null) ?? null,
        lastError: row.last_status === 'failed' ? (lastRun.error ?? null) : null,
        totalBytes: Number(row.total_bytes ?? 0),
        runCount: Number(row.run_count ?? 0),
        created: row.created
    };
}

/**
 * L'intitulé de la source, relu à l'affichage et recopié nulle part : un
 * partage renommé ou une base supprimée doivent se voir.
 */
export async function sourceNameOf(
    ctx: Ctx,
    kind: BackupSourceKind,
    sourceId: number | null,
    /** L'espace du travail : sa source vit chez lui, pas forcément ici. */
    homeWorkspaceId: number,
    job: Partial<StoredJob>
): Promise<string | null> {
    switch (kind) {
        case 'deveye':
            return 'Base de DevEye';
        case 'deviceFolder': {
            const folder = job.folder;
            if (!folder?.deviceId || !folder.path) return null;
            // Une machine d'un autre espace ne se nomme pas d'ici : son chemin suffit.
            const device = (await deviceNamesOf(ctx)).get(folder.deviceId);
            return device ? `${device} : ${folder.path}` : folder.path;
        }
        case 'dockerVolume': {
            const volume = job.volume;
            if (!volume?.deviceId || !volume.name) return null;
            const device = (await deviceNamesOf(ctx)).get(volume.deviceId);
            return device ? `${device} : ${volume.name}` : volume.name;
        }
        case 'mailbox': {
            if (sourceId === null) return null;
            const mailbox = await mailProvider(ctx)?.findMailbox(sourceId, homeWorkspaceId);
            return mailbox?.address ?? null;
        }
        case 'database': {
            if (sourceId === null) return null;
            const row = await databaseProvider(ctx)?.findDatabase(sourceId, homeWorkspaceId);
            return row?.name ?? null;
        }
        case 'cloudsync':
        case 'hostingFolder': {
            if (sourceId === null) return null;
            const root = await treeProvider(ctx, kind)?.find(sourceId, homeWorkspaceId);
            return root?.name ?? null;
        }
    }
}

export async function toRun(ctx: Ctx, row: BackupRunRow, cipher?: SdkCipher): Promise<BackupRun> {
    const stored = await readJsonWith<StoredRun>(cipher ?? ctx.cipher(), row.content);
    return {
        id: row.id,
        jobId: row.job_id,
        status: row.status as BackupRunStatus,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        sizeBytes: Number(row.size_bytes ?? 0),
        checksum: row.checksum,
        artifact: stored.artifact ?? null,
        encrypted: row.encrypted === 1,
        triggeredByUserId: row.triggered_by_user_id,
        // Soldée au démarrage, l'exécution n'a pas de message : le processus est mort avant.
        error:
            row.status === 'failed'
                ? (stored.error ?? 'Interrompue : le serveur a redémarré pendant la sauvegarde.')
                : null,
        warning: stored.warning ?? null,
        pruned: row.pruned === 1
    };
}
