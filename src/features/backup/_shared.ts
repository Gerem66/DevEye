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
} from 'deveye-types';

import type { Cipher } from '@/Services/SecureStore';
import type { FeatureAccessSpec, FeatureContext } from '../_define';
import { FeatureError } from '../_define';
import type { ShareScope } from '../_sharing';
import type { StoredDestination, StoredJob, StoredRun } from '@/Services/BackupService';
import { CLOUDSYNC_BACKUP_PROVIDER, type CloudSyncBackupProvider } from 'deveye-types/sdk';
import { moduleProvider } from '@/features/_sdk/register';

/**
 * Ce que les handlers de sauvegarde partagent : les gardes d'accès, la lecture
 * du chiffré, et la projection des lignes SQL vers les DTO.
 *
 * **Aucun `assertSecureUnlocked` nulle part**, et c'est la propriété qui fonde
 * le module : tout vit à l'étage ouvert, parce qu'une sauvegarde doit partir à
 * 3 h du matin. Une commande qui exigerait une session déverrouillée serait un
 * travail qui ne s'exécute que quand quelqu'un regarde.
 */

export const READ: FeatureAccessSpec = { feature: 'backup', level: 'read' };
export const WRITE: FeatureAccessSpec = { feature: 'backup', level: 'write' };

/** Lit un blob JSON chiffré, en tolérant l'illisible (liste dégradée, pas vide). */
export async function readJson<T>(ctx: FeatureContext, blob: string): Promise<Partial<T>> {
    return readJsonWith<T>(ctx.secure.open, blob);
}

/** La même lecture, sous un codec explicite — celui du domicile d'une ligne projetée. */
export async function readJsonWith<T>(cipher: Cipher, blob: string): Promise<Partial<T>> {
    if (!blob) return {};
    try {
        const raw = await cipher.tryDecrypt(blob);
        return raw ? (JSON.parse(raw) as Partial<T>) : {};
    } catch {
        return {};
    }
}

export function backupService(ctx: FeatureContext) {
    if (!ctx.backups) throw new FeatureError('internal', 'Le moteur de sauvegardes est indisponible.');
    return ctx.backups;
}

export async function loadDestination(ctx: FeatureContext, destinationId: number): Promise<BackupDestinationRow> {
    const row = await ctx.db.backup.findDestination(destinationId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Destination introuvable');
    return row;
}

/**
 * Un travail visible depuis cet espace — le sien, ou un que l'on y projette.
 * `level` décide de la garde : `assertItem` refuse en plus les travaux qu'une
 * restriction de rôle masque ou passe en lecture seule.
 */
export async function loadJob(ctx: FeatureContext, jobId: number, level: 'read' | 'write' = 'read') {
    const row = await ctx.db.backup.findVisibleJob(jobId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Travail de sauvegarde introuvable');
    await ctx.assertItem('backup', jobId, level);
    return row;
}

/**
 * Comme {@link loadJob}, mais exige que le travail soit **chez l'appelant**.
 *
 * Pour les gestes réservés au domicile : le modifier (sa destination et sa
 * source se choisissent parmi les objets de SON espace, que la fenêtre ne voit
 * pas) et le supprimer. Une fenêtre lit, déclenche et suit.
 */
export async function loadHomeJob(ctx: FeatureContext, jobId: number) {
    const row = await loadJob(ctx, jobId, 'write');
    if (row.workspace_id !== ctx.workspaceId) {
        throw new FeatureError(
            'forbidden',
            'Ce travail appartient à un autre espace : il se modifie et se supprime depuis là-bas.'
        );
    }
    return row;
}

export async function toDestination(
    ctx: FeatureContext,
    row: BackupDestinationWithUsageRow
): Promise<BackupDestination> {
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
        // Le secret ne sort jamais : un secret qu'on ne renvoie pas ne peut
        // fuiter ni par une capture d'écran ni par un journal.
        hasSecret: row.secret_enc.length > 0,
        pathStyle: row.path_style === 1,
        status: row.status as BackupDestinationStatus,
        lastError: stored.lastError ?? null,
        checkedAt: row.checked_at,
        jobCount: Number(row.job_count ?? 0),
        created: row.created
    };
}

export async function toJob(ctx: FeatureContext, row: BackupJobWithStateRow, shares?: ShareScope): Promise<BackupJob> {
    // Le codec du **domicile** de la ligne : un travail projeté — et tout ce qui
    // pend à lui, sa destination, sa dernière erreur — reste chiffré sous la clé
    // de son espace d'origine.
    const cipher = shares ? await shares.cipherFor(row.id) : ctx.secure.open;
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
        sourceName: await sourceNameOf(
            ctx,
            row.source_kind as BackupSourceKind,
            row.source_id,
            row.workspace_id,
            cipher
        ),
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
 * L'intitulé de la source d'un travail, relu au moment de l'affichage.
 *
 * Recopié nulle part exprès : un partage renommé doit apparaître sous son
 * nouveau nom, et une base supprimée doit se voir comme telle plutôt que de
 * laisser croire que le travail tourne toujours.
 */
export async function sourceNameOf(
    ctx: FeatureContext,
    kind: BackupSourceKind,
    sourceId: number | null,
    /** L'espace du travail — sa source vit chez lui, pas forcément ici. */
    homeWorkspaceId: number = ctx.workspaceId,
    cipher?: Cipher
): Promise<string | null> {
    if (kind === 'deveye') return 'Base de DevEye';
    if (sourceId === null) return null;

    if (kind === 'database') {
        const row = await ctx.db.databases.find(sourceId, homeWorkspaceId);
        if (!row) return null;
        const stored = await readJsonWith<{ name: string }>(cipher ?? ctx.secure.open, row.content);
        return stored.name ?? null;
    }

    const provider = moduleProvider<CloudSyncBackupProvider>(CLOUDSYNC_BACKUP_PROVIDER);
    if (!provider) return null;
    const share = await provider.findShare(sourceId);
    return share && share.workspaceId === homeWorkspaceId ? share.name : null;
}

export async function toRun(ctx: FeatureContext, row: BackupRunRow, cipher?: Cipher): Promise<BackupRun> {
    const stored = await readJsonWith<StoredRun>(cipher ?? ctx.secure.open, row.content);
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
        // Une exécution soldée au démarrage n'a pas de message : le processus
        // est mort avant d'en écrire un. On le dit plutôt que de laisser un
        // « échec » sans cause.
        error:
            row.status === 'failed'
                ? (stored.error ?? 'Interrompue : le serveur a redémarré pendant la sauvegarde.')
                : null,
        pruned: row.pruned === 1
    };
}
