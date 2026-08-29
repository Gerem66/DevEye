import type {
    BackupDestinationRow,
    BackupDestinationWithUsageRow,
    BackupJobRow,
    BackupJobWithStateRow,
    BackupRunRow
} from '../contracts/domain';
import type { SdkQueryable } from '@deveye/types/sdk/server';

type Q = SdkQueryable;

/**
 * Trois tables, un dépôt : elles ne se lisent jamais séparément. Tout est
 * chiffré à l'étage ouvert (l'ordonnanceur lit sans session) ; ne restent en
 * clair que `kind`, `source_kind`, `device_id`, le calendrier et les drapeaux.
 */
export interface BackupRepo {
    listDestinations(workspaceId: number): Promise<BackupDestinationWithUsageRow[]>;
    findDestination(id: number, workspaceId: number): Promise<BackupDestinationRow | null>;
    /** La destination d'un travail, retrouvée sans repasser par l'espace. */
    findDestinationForJob(jobId: number): Promise<BackupDestinationRow | null>;
    createDestination(input: {
        workspaceId: number;
        kind: string;
        deviceId: string | null;
        pathStyle: boolean;
        content: string;
        secretEnc: string;
    }): Promise<BackupDestinationRow>;
    updateDestination(
        id: number,
        workspaceId: number,
        input: {
            deviceId: string | null;
            pathStyle: boolean;
            content: string;
            /** Absent = secret inchangé. Le client ne l'a jamais reçu. */
            secretEnc?: string;
        }
    ): Promise<BackupDestinationRow | null>;
    /** Le verdict du dernier contrôle. Écrit aussi par l'ordonnanceur, sans session. */
    recordDestinationProbe(id: number, at: number, status: 'ok' | 'error', content: string): Promise<void>;
    deleteDestination(id: number, workspaceId: number): Promise<boolean>;
    countJobsUsing(destinationId: number): Promise<number>;

    listJobs(workspaceId: number): Promise<BackupJobWithStateRow[]>;
    /** Comme `listJobs`, plus les travaux projetés vers cet espace. */
    listVisibleJobs(workspaceId: number): Promise<BackupJobWithStateRow[]>;
    findJob(id: number, workspaceId: number): Promise<BackupJobRow | null>;
    /** Comme `findJob`, mais accepte aussi un travail projeté vers cet espace. */
    findVisibleJob(id: number, workspaceId: number): Promise<BackupJobRow | null>;
    findJobWithState(id: number, workspaceId: number): Promise<BackupJobWithStateRow | null>;
    findVisibleJobWithState(id: number, workspaceId: number): Promise<BackupJobWithStateRow | null>;
    /** Sans filtre d'espace : l'ordonnanceur tient déjà l'identité de la ligne. */
    findJobById(id: number): Promise<BackupJobRow | null>;
    countJobs(workspaceId: number): Promise<{ count: number; failing: number }>;
    createJob(input: {
        workspaceId: number;
        destinationId: number;
        sourceKind: string;
        sourceId: number | null;
        enabled: boolean;
        scheduleKind: string;
        scheduleHour: number;
        scheduleWeekday: number;
        scheduleDay: number;
        keepLast: number;
        /** 'none' | 'server' : la forme des archives (voir `backupEncryptionSchema`). */
        encryption: string;
        nextRunAt: number | null;
        content: string;
    }): Promise<BackupJobRow>;
    updateJob(
        id: number,
        workspaceId: number,
        input: {
            destinationId: number;
            sourceKind: string;
            sourceId: number | null;
            enabled: boolean;
            scheduleKind: string;
            scheduleHour: number;
            scheduleWeekday: number;
            scheduleDay: number;
            keepLast: number;
            encryption: string;
            nextRunAt: number | null;
            content: string;
        }
    ): Promise<BackupJobRow | null>;
    deleteJob(id: number, workspaceId: number): Promise<boolean>;
    /**
     * Les travaux dus, le plus en retard d'abord. `next_run_at IS NULL` (manuel
     * ou désactivé) les exclut par l'index seul.
     */
    listJobsDue(now: number, limit: number): Promise<BackupJobRow[]>;
    /** Repousse l'échéance. Appelé avant l'exécution, jamais après : un travail
     *  qui plante ne doit pas repartir en boucle au tour suivant. */
    setNextRun(id: number, nextRunAt: number | null): Promise<void>;

    listRuns(jobId: number, workspaceId: number, limit: number): Promise<BackupRunRow[]>;
    listWorkspaceRuns(workspaceId: number, limit: number): Promise<BackupRunRow[]>;
    findRun(id: number): Promise<BackupRunRow | null>;
    startRun(input: {
        jobId: number;
        workspaceId: number;
        encrypted: boolean;
        triggeredByUserId: number | null;
        content: string;
    }): Promise<BackupRunRow>;
    finishRun(
        id: number,
        input: {
            status: 'success' | 'failed';
            finishedAt: number;
            sizeBytes: number;
            checksum: string | null;
            content: string;
        }
    ): Promise<void>;
    /**
     * Les archives à effacer pour tenir `keepLast` : les réussites encore
     * présentes au-delà des `keepLast` plus récentes.
     */
    listRunsToPrune(jobId: number, keepLast: number): Promise<BackupRunRow[]>;
    markPruned(id: number): Promise<void>;
    /** Les exécutions restées `running` après une mort du processus, soldées au démarrage. */
    failStaleRuns(before: number): Promise<number>;
}

const DEST_SELECT = `
    SELECT d.*,
           (SELECT COUNT(*) FROM backup_jobs j WHERE j.destination_id = d.id) AS job_count,
           dev.name AS device_name
      FROM backup_destinations d
      LEFT JOIN devices dev ON dev.id = d.device_id`;

const JOB_SELECT = `
    SELECT j.*,
           d.kind    AS destination_kind,
           d.content AS destination_content,
           r.started_at AS last_run_at,
           r.status     AS last_status,
           r.content    AS last_run_content,
           (SELECT COALESCE(SUM(x.size_bytes), 0) FROM backup_runs x
             WHERE x.job_id = j.id AND x.status = 'success' AND x.pruned = 0) AS total_bytes,
           (SELECT COUNT(*) FROM backup_runs x WHERE x.job_id = j.id) AS run_count
      FROM backup_jobs j
      JOIN backup_destinations d ON d.id = j.destination_id
      -- La dernière exécution, quelle qu'elle soit : une réussite qui masquerait
      -- l'échec d'après ferait afficher « tout va bien » à un travail cassé.
      LEFT JOIN backup_runs r
             ON r.id = (SELECT y.id FROM backup_runs y WHERE y.job_id = j.id ORDER BY y.started_at DESC, y.id DESC LIMIT 1)`;

export function createRepo(q: Q): BackupRepo {
    const destById = async (id: number): Promise<BackupDestinationRow> => {
        const rows = await q.query<BackupDestinationRow>('SELECT * FROM backup_destinations WHERE id = ?', [id]);
        return rows[0];
    };
    const jobById = async (id: number): Promise<BackupJobRow> => {
        const rows = await q.query<BackupJobRow>('SELECT * FROM backup_jobs WHERE id = ?', [id]);
        return rows[0];
    };

    return {
        listDestinations: (workspaceId) =>
            q.query<BackupDestinationWithUsageRow>(
                `${DEST_SELECT} WHERE d.workspace_id = ? ORDER BY d.created ASC, d.id ASC`,
                [workspaceId]
            ),

        async findDestination(id, workspaceId) {
            const rows = await q.query<BackupDestinationRow>(
                'SELECT * FROM backup_destinations WHERE id = ? AND workspace_id = ?',
                [id, workspaceId]
            );
            return rows[0] ?? null;
        },

        async findDestinationForJob(jobId) {
            const rows = await q.query<BackupDestinationRow>(
                `SELECT d.* FROM backup_destinations d
                   JOIN backup_jobs j ON j.destination_id = d.id
                  WHERE j.id = ?`,
                [jobId]
            );
            return rows[0] ?? null;
        },

        async createDestination(input) {
            const res = await q.execute(
                `INSERT INTO backup_destinations
                    (workspace_id, kind, device_id, path_style, content, secret_enc)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [input.workspaceId, input.kind, input.deviceId, input.pathStyle ? 1 : 0, input.content, input.secretEnc]
            );
            return destById(res.insertId);
        },

        async updateDestination(id, workspaceId, input) {
            const sets = ['device_id = ?', 'path_style = ?', 'content = ?'];
            const params: unknown[] = [input.deviceId, input.pathStyle ? 1 : 0, input.content];
            if (input.secretEnc !== undefined) {
                sets.push('secret_enc = ?');
                params.push(input.secretEnc);
            }
            params.push(id, workspaceId);
            const res = await q.execute(
                `UPDATE backup_destinations SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`,
                params
            );
            return res.affectedRows === 0 ? null : destById(id);
        },

        async recordDestinationProbe(id, at, status, content) {
            await q.execute('UPDATE backup_destinations SET status = ?, checked_at = ?, content = ? WHERE id = ?', [
                status,
                at,
                content,
                id
            ]);
        },

        async deleteDestination(id, workspaceId) {
            const res = await q.execute('DELETE FROM backup_destinations WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },

        async countJobsUsing(destinationId) {
            const rows = await q.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM backup_jobs WHERE destination_id = ?',
                [destinationId]
            );
            return Number(rows[0]?.n ?? 0);
        },

        listJobs: (workspaceId) =>
            q.query<BackupJobWithStateRow>(`${JOB_SELECT} WHERE j.workspace_id = ? ORDER BY j.created ASC, j.id ASC`, [
                workspaceId
            ]),

        listVisibleJobs: (workspaceId) =>
            q.query<BackupJobWithStateRow>(
                `${JOB_SELECT} WHERE j.workspace_id = ?
                 UNION
                 ${JOB_SELECT}
                  JOIN item_shares sh
                    ON sh.feature = 'backup' AND sh.item_id = j.id AND sh.home_workspace_id = j.workspace_id
                 WHERE sh.workspace_id = ?
                 ORDER BY created ASC, id ASC`,
                [workspaceId, workspaceId]
            ),

        async findJob(id, workspaceId) {
            const rows = await q.query<BackupJobRow>('SELECT * FROM backup_jobs WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return rows[0] ?? null;
        },

        async findVisibleJob(id, workspaceId) {
            const rows = await q.query<BackupJobRow>(
                `SELECT j.* FROM backup_jobs j
                  WHERE j.id = ?
                    AND (j.workspace_id = ?
                         OR EXISTS (SELECT 1 FROM item_shares sh
                                     WHERE sh.feature = 'backup' AND sh.item_id = j.id
                                       AND sh.home_workspace_id = j.workspace_id
                                       AND sh.workspace_id = ?))`,
                [id, workspaceId, workspaceId]
            );
            return rows[0] ?? null;
        },

        async findVisibleJobWithState(id, workspaceId) {
            const rows = await q.query<BackupJobWithStateRow>(
                `${JOB_SELECT}
                  WHERE j.id = ?
                    AND (j.workspace_id = ?
                         OR EXISTS (SELECT 1 FROM item_shares sh
                                     WHERE sh.feature = 'backup' AND sh.item_id = j.id
                                       AND sh.home_workspace_id = j.workspace_id
                                       AND sh.workspace_id = ?))`,
                [id, workspaceId, workspaceId]
            );
            return rows[0] ?? null;
        },

        async findJobWithState(id, workspaceId) {
            const rows = await q.query<BackupJobWithStateRow>(`${JOB_SELECT} WHERE j.id = ? AND j.workspace_id = ?`, [
                id,
                workspaceId
            ]);
            return rows[0] ?? null;
        },

        async findJobById(id) {
            const rows = await q.query<BackupJobRow>('SELECT * FROM backup_jobs WHERE id = ?', [id]);
            return rows[0] ?? null;
        },

        async countJobs(workspaceId) {
            const rows = await q.query<{ n: number; failing: number }>(
                `SELECT COUNT(*) AS n,
                        SUM(
                            CASE WHEN (SELECT y.status FROM backup_runs y
                                        WHERE y.job_id = j.id
                                        ORDER BY y.started_at DESC, y.id DESC LIMIT 1) = 'failed'
                                 THEN 1 ELSE 0 END
                        ) AS failing
                   FROM backup_jobs j
                  WHERE j.workspace_id = ? AND j.enabled = 1`,
                [workspaceId]
            );
            return { count: Number(rows[0]?.n ?? 0), failing: Number(rows[0]?.failing ?? 0) };
        },

        async createJob(input) {
            const res = await q.execute(
                `INSERT INTO backup_jobs
                    (workspace_id, destination_id, source_kind, source_id, enabled,
                     schedule_kind, schedule_hour, schedule_weekday, schedule_day,
                     keep_last, encryption, next_run_at, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    input.workspaceId,
                    input.destinationId,
                    input.sourceKind,
                    input.sourceId,
                    input.enabled ? 1 : 0,
                    input.scheduleKind,
                    input.scheduleHour,
                    input.scheduleWeekday,
                    input.scheduleDay,
                    input.keepLast,
                    input.encryption,
                    input.nextRunAt,
                    input.content
                ]
            );
            return jobById(res.insertId);
        },

        async updateJob(id, workspaceId, input) {
            const res = await q.execute(
                `UPDATE backup_jobs
                    SET destination_id = ?, source_kind = ?, source_id = ?, enabled = ?,
                        schedule_kind = ?, schedule_hour = ?, schedule_weekday = ?, schedule_day = ?,
                        keep_last = ?, encryption = ?, next_run_at = ?, content = ?
                  WHERE id = ? AND workspace_id = ?`,
                [
                    input.destinationId,
                    input.sourceKind,
                    input.sourceId,
                    input.enabled ? 1 : 0,
                    input.scheduleKind,
                    input.scheduleHour,
                    input.scheduleWeekday,
                    input.scheduleDay,
                    input.keepLast,
                    input.encryption,
                    input.nextRunAt,
                    input.content,
                    id,
                    workspaceId
                ]
            );
            return res.affectedRows === 0 ? null : jobById(id);
        },

        async deleteJob(id, workspaceId) {
            const res = await q.execute('DELETE FROM backup_jobs WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
            return res.affectedRows > 0;
        },

        listJobsDue: (now, limit) =>
            q.query<BackupJobRow>(
                `SELECT * FROM backup_jobs
                  WHERE next_run_at IS NOT NULL AND next_run_at <= ?
                  ORDER BY next_run_at ASC
                  LIMIT ${Math.max(1, Math.trunc(limit))}`,
                [now]
            ),

        async setNextRun(id, nextRunAt) {
            await q.execute('UPDATE backup_jobs SET next_run_at = ? WHERE id = ?', [nextRunAt, id]);
        },

        listRuns: (jobId, workspaceId, limit) =>
            q.query<BackupRunRow>(
                `SELECT * FROM backup_runs
                  WHERE job_id = ? AND workspace_id = ?
                  ORDER BY started_at DESC, id DESC
                  LIMIT ${Math.max(1, Math.trunc(limit))}`,
                [jobId, workspaceId]
            ),

        listWorkspaceRuns: (workspaceId, limit) =>
            q.query<BackupRunRow>(
                `SELECT * FROM backup_runs
                  WHERE workspace_id = ?
                  ORDER BY started_at DESC, id DESC
                  LIMIT ${Math.max(1, Math.trunc(limit))}`,
                [workspaceId]
            ),

        async findRun(id) {
            const rows = await q.query<BackupRunRow>('SELECT * FROM backup_runs WHERE id = ?', [id]);
            return rows[0] ?? null;
        },

        async startRun(input) {
            const res = await q.execute(
                `INSERT INTO backup_runs (job_id, workspace_id, encrypted, triggered_by_user_id, content)
                 VALUES (?, ?, ?, ?, ?)`,
                [input.jobId, input.workspaceId, input.encrypted ? 1 : 0, input.triggeredByUserId, input.content]
            );
            const rows = await q.query<BackupRunRow>('SELECT * FROM backup_runs WHERE id = ?', [res.insertId]);
            return rows[0];
        },

        async finishRun(id, input) {
            await q.execute(
                `UPDATE backup_runs
                    SET status = ?, finished_at = ?, size_bytes = ?, checksum = ?, content = ?
                  WHERE id = ?`,
                [input.status, input.finishedAt, input.sizeBytes, input.checksum, input.content, id]
            );
        },

        listRunsToPrune: (jobId, keepLast) =>
            q.query<BackupRunRow>(
                `SELECT * FROM backup_runs
                  WHERE job_id = ? AND status = 'success' AND pruned = 0
                  ORDER BY started_at DESC, id DESC
                  LIMIT 1000 OFFSET ${Math.max(1, Math.trunc(keepLast))}`,
                [jobId]
            ),

        async markPruned(id) {
            await q.execute('UPDATE backup_runs SET pruned = 1 WHERE id = ?', [id]);
        },

        async failStaleRuns(before) {
            const res = await q.execute(
                `UPDATE backup_runs
                    SET status = 'failed', finished_at = ?
                  WHERE status = 'running' AND started_at < ?`,
                [Math.floor(Date.now() / 1000), before]
            );
            return res.affectedRows;
        }
    };
}
