import type {
    BackupDestination,
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
    BackupSourceKind
} from '../contracts/domain';

import {
    CLOUDSYNC_BACKUP_PROVIDER,
    DATABASE_BACKUP_PROVIDER,
    type CloudSyncBackupProvider,
    type DatabaseBackupProvider
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

/** Les deux contrats consommés, relus à l'appel : chacun peut être absent. */
export function cloudSyncProvider(ctx: Pick<Ctx, 'providers'>): CloudSyncBackupProvider | undefined {
    return ctx.providers.get<CloudSyncBackupProvider>(CLOUDSYNC_BACKUP_PROVIDER);
}

export function databaseProvider(ctx: Pick<Ctx, 'providers'>): DatabaseBackupProvider | undefined {
    return ctx.providers.get<DatabaseBackupProvider>(DATABASE_BACKUP_PROVIDER);
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
        sourceName: await sourceNameOf(ctx, row.source_kind as BackupSourceKind, row.source_id, row.workspace_id),
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
    homeWorkspaceId: number = ctx.workspaceId
): Promise<string | null> {
    if (kind === 'deveye') return 'Base de DevEye';
    if (sourceId === null) return null;

    if (kind === 'database') {
        const row = await databaseProvider(ctx)?.findDatabase(sourceId, homeWorkspaceId);
        return row?.name ?? null;
    }

    const share = await cloudSyncProvider(ctx)?.findShare(sourceId);
    return share && share.workspaceId === homeWorkspaceId ? share.name : null;
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
        pruned: row.pruned === 1
    };
}
