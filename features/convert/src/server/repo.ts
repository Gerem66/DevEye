import type { SdkQueryable } from '@deveye/types/sdk/server';

import type { ConvertKind } from '../contracts/catalogue';
import type { ConvertErrorCode, ConvertPhase } from '../contracts/domain';
import type { OptionValues } from '../contracts/options';

export interface JobRow {
    id: number;
    workspace_id: number;
    user_id: number;
    kind: ConvertKind;
    source_format: string;
    target_format: string;
    options: unknown;
    original_name_enc: string;
    input_bytes: number | string;
    output_bytes: number | string | null;
    phase: ConvertPhase;
    progress_permille: number;
    attempts: number;
    error_code: string | null;
    error_enc: string | null;
    created: number | string;
    started_at: number | string | null;
    finished_at: number | string | null;
    expires_at: number | string | null;
}

export interface NewJob {
    workspaceId: number;
    userId: number;
    kind: ConvertKind;
    sourceFormat: string;
    targetFormat: string;
    options: OptionValues;
    originalNameEnc: string;
    declaredBytes: number;
    at: number;
}

export interface StoredRates {
    asOf: string | null;
    rates: Record<string, number>;
}

/** Les deux états au repos qui promettent un fichier. */
export type FilePhase = 'queued' | 'done';

/** Un travail désigné par ce qui suffit à retrouver son dossier. */
export interface JobRef {
    id: number;
    workspaceId: number;
}

/**
 * Chaque transition d'état est un `UPDATE ... WHERE phase = <attendue>` dont on
 * lit le nombre de lignes touchées : c'est la ligne, et elle seule, qui départage
 * deux appels simultanés (double clic, ticket de montée rejoué).
 */
export interface ConvertRepo {
    insert(job: NewJob): Promise<number>;
    find(id: number, workspaceId: number): Promise<JobRow | null>;
    /**
     * Les travaux qu'un membre voit : les siens, sauf les annulés et ceux dont
     * le résultat est parti. Un fichier converti est personnel, même dans un
     * espace partagé.
     */
    list(workspaceId: number, userId: number, limit: number): Promise<JobRow[]>;
    /** Ce que les travaux de l'espace occupent, ou vont occuper, sur le disque. */
    heldBytes(workspaceId: number): Promise<number>;
    /** Les travaux ouverts dans ces espaces : créés, en montée, en file ou en cours. Ce qu'une offre borne. */
    openJobs(workspaceIds: readonly number[]): Promise<number>;
    /** Le poids des résultats qui attendent d'être récupérés dans ces espaces. Ce qu'une offre borne. */
    resultBytes(workspaceIds: readonly number[]): Promise<number>;

    claimForUpload(id: number, workspaceId: number): Promise<JobRow | null>;
    queue(id: number, inputBytes: number): Promise<void>;
    claimQueued(at: number): Promise<JobRow | null>;
    progress(id: number, permille: number): Promise<void>;
    finish(id: number, outputBytes: number, at: number, expiresAt: number): Promise<void>;
    fail(id: number, code: ConvertErrorCode, errorEnc: string | null, at: number): Promise<void>;
    /** Vrai si le travail était encore annulable. */
    cancel(id: number, workspaceId: number, at: number): Promise<boolean>;
    /** Vrai si la ligne est partie : seul un travail au repos se retire. */
    remove(id: number, workspaceId: number): Promise<boolean>;

    /** Ce qu'un arrêt brutal a laissé en plan : rend le nombre de travaux remis en file. */
    recoverStale(maxAttempts: number, at: number): Promise<number>;
    /** Passe en `expired` les résultats échus et les envois jamais venus, et rend ceux dont le dossier est à retirer. */
    expire(at: number, uploadsBefore: number): Promise<JobRef[]>;
    /** Les travaux dont le dossier doit survivre à un balayage, sous la forme `espace/travail`. */
    liveKeys(): Promise<Set<string>>;
    /** Les travaux dont l'état promet un fichier sur le disque : l'entrée en file, le résultat une fois fini. */
    promisingFile(): Promise<(JobRef & { phase: FilePhase })[]>;
    /**
     * Le fichier promis a disparu. Ne touche la ligne que si elle est encore
     * dans l'état où on l'a lue : un travail parti entre-temps a, lui, retiré
     * son entrée pour de bon.
     */
    markLost(id: number, phase: FilePhase, at: number): Promise<boolean>;
    purgeOld(before: number): Promise<void>;

    rates(): Promise<StoredRates>;
    saveRates(asOf: string, rates: Readonly<Record<string, number>>, at: number): Promise<void>;
    fxState(): Promise<{ lastAttemptAt: number; lastSuccessAt: number }>;
    markFxAttempt(at: number, success: boolean): Promise<void>;
}

/** Autant de `?` que d'identifiants, pour un `IN (...)`. */
const marks = (ids: readonly number[]): string => ids.map(() => '?').join(', ');

const HOLDING = "('awaiting_upload', 'uploading', 'queued', 'running', 'done')";

export function createRepo(q: SdkQueryable): ConvertRepo {
    const find = async (id: number, workspaceId: number): Promise<JobRow | null> => {
        const rows = await q.query<JobRow>('SELECT * FROM ft_convert_jobs WHERE id = ? AND workspace_id = ?', [
            id,
            workspaceId
        ]);
        return rows[0] ?? null;
    };

    return {
        find,

        async insert(job) {
            const result = await q.execute(
                `INSERT INTO ft_convert_jobs
                    (workspace_id, user_id, kind, source_format, target_format, options, original_name_enc, input_bytes, created)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    job.workspaceId,
                    job.userId,
                    job.kind,
                    job.sourceFormat,
                    job.targetFormat,
                    JSON.stringify(job.options),
                    job.originalNameEnc,
                    job.declaredBytes,
                    job.at
                ]
            );
            return result.insertId;
        },

        list(workspaceId, userId, limit) {
            return q.query<JobRow>(
                `SELECT * FROM ft_convert_jobs
                 WHERE workspace_id = ? AND user_id = ? AND phase NOT IN ('canceled', 'expired')
                 ORDER BY created DESC, id DESC LIMIT ?`,
                [workspaceId, userId, limit]
            );
        },

        async heldBytes(workspaceId) {
            // L'entrée quitte le disque dès que le résultat est là : un travail fini ne pèse plus que sa sortie.
            const rows = await q.query<{ held: number | string | null }>(
                `SELECT SUM(CASE WHEN phase = 'done' THEN COALESCE(output_bytes, 0) ELSE input_bytes END) AS held
                 FROM ft_convert_jobs WHERE workspace_id = ? AND phase IN ${HOLDING}`,
                [workspaceId]
            );
            return Number(rows[0]?.held ?? 0);
        },

        async openJobs(workspaceIds) {
            if (workspaceIds.length === 0) return 0;
            const rows = await q.query<{ open: number | string }>(
                `SELECT COUNT(*) AS open FROM ft_convert_jobs
                 WHERE workspace_id IN (${marks(workspaceIds)})
                   AND phase IN ('awaiting_upload', 'uploading', 'queued', 'running')`,
                [...workspaceIds]
            );
            return Number(rows[0]?.open ?? 0);
        },

        async resultBytes(workspaceIds) {
            if (workspaceIds.length === 0) return 0;
            const rows = await q.query<{ held: number | string | null }>(
                `SELECT SUM(output_bytes) AS held FROM ft_convert_jobs
                 WHERE workspace_id IN (${marks(workspaceIds)}) AND phase = 'done'`,
                [...workspaceIds]
            );
            return Number(rows[0]?.held ?? 0);
        },

        async claimForUpload(id, workspaceId) {
            const result = await q.execute(
                `UPDATE ft_convert_jobs SET phase = 'uploading'
                 WHERE id = ? AND workspace_id = ? AND phase = 'awaiting_upload'`,
                [id, workspaceId]
            );
            return result.affectedRows === 1 ? find(id, workspaceId) : null;
        },

        async queue(id, inputBytes) {
            await q.execute(
                `UPDATE ft_convert_jobs SET phase = 'queued', input_bytes = ? WHERE id = ? AND phase = 'uploading'`,
                [inputBytes, id]
            );
        },

        async claimQueued(at) {
            const next = await q.query<JobRow>(
                `SELECT * FROM ft_convert_jobs WHERE phase = 'queued' ORDER BY created, id LIMIT 1`
            );
            if (!next[0]) return null;
            const result = await q.execute(
                `UPDATE ft_convert_jobs
                 SET phase = 'running', started_at = ?, attempts = attempts + 1, progress_permille = 0
                 WHERE id = ? AND phase = 'queued'`,
                [at, next[0].id]
            );
            return result.affectedRows === 1 ? { ...next[0], phase: 'running' } : null;
        },

        async progress(id, permille) {
            await q.execute(`UPDATE ft_convert_jobs SET progress_permille = ? WHERE id = ? AND phase = 'running'`, [
                permille,
                id
            ]);
        },

        async finish(id, outputBytes, at, expiresAt) {
            await q.execute(
                `UPDATE ft_convert_jobs
                 SET phase = 'done', output_bytes = ?, progress_permille = 1000, finished_at = ?, expires_at = ?
                 WHERE id = ? AND phase = 'running'`,
                [outputBytes, at, expiresAt, id]
            );
        },

        async fail(id, code, errorEnc, at) {
            await q.execute(
                `UPDATE ft_convert_jobs SET phase = 'error', error_code = ?, error_enc = ?, finished_at = ?
                 WHERE id = ? AND phase IN ('uploading', 'queued', 'running')`,
                [code, errorEnc, at, id]
            );
        },

        async cancel(id, workspaceId, at) {
            const result = await q.execute(
                `UPDATE ft_convert_jobs SET phase = 'canceled', finished_at = ?
                 WHERE id = ? AND workspace_id = ? AND phase IN ('awaiting_upload', 'uploading', 'queued', 'running')`,
                [at, id, workspaceId]
            );
            return result.affectedRows === 1;
        },

        async remove(id, workspaceId) {
            const result = await q.execute(
                `DELETE FROM ft_convert_jobs
                 WHERE id = ? AND workspace_id = ? AND phase IN ('done', 'error', 'canceled', 'expired')`,
                [id, workspaceId]
            );
            return result.affectedRows === 1;
        },

        async recoverStale(maxAttempts, at) {
            // Un fichier dont la réception a été coupée est tronqué, sans qu'on sache où : rien à reprendre.
            await q.execute(
                `UPDATE ft_convert_jobs SET phase = 'error', error_code = 'upload_interrupted', finished_at = ?
                 WHERE phase = 'uploading'`,
                [at]
            );
            await q.execute(
                `UPDATE ft_convert_jobs SET phase = 'error', error_code = 'interrupted', finished_at = ?
                 WHERE phase = 'running' AND attempts >= ?`,
                [at, maxAttempts]
            );
            const result = await q.execute(`UPDATE ft_convert_jobs SET phase = 'queued' WHERE phase = 'running'`);
            return result.affectedRows;
        },

        async expire(at, uploadsBefore) {
            const due = await q.query<{ id: number; workspace_id: number }>(
                `SELECT id, workspace_id FROM ft_convert_jobs
                 WHERE (phase = 'done' AND expires_at <= ?) OR (phase = 'awaiting_upload' AND created < ?)`,
                [at, uploadsBefore]
            );
            for (const job of due) {
                await q.execute(
                    `UPDATE ft_convert_jobs SET phase = 'expired' WHERE id = ? AND phase IN ('done', 'awaiting_upload')`,
                    [job.id]
                );
            }
            return due.map((job) => ({ id: job.id, workspaceId: job.workspace_id }));
        },

        async liveKeys() {
            const rows = await q.query<{ id: number; workspace_id: number }>(
                `SELECT id, workspace_id FROM ft_convert_jobs WHERE phase IN ${HOLDING}`
            );
            return new Set(rows.map((row) => `${row.workspace_id}/${row.id}`));
        },

        async promisingFile() {
            const rows = await q.query<{ id: number; workspace_id: number; phase: FilePhase }>(
                `SELECT id, workspace_id, phase FROM ft_convert_jobs WHERE phase IN ('queued', 'done')`
            );
            return rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, phase: row.phase }));
        },

        async markLost(id, phase, at) {
            const result = await q.execute(
                `UPDATE ft_convert_jobs
                 SET phase = 'error', error_code = 'file_lost', error_enc = NULL, expires_at = NULL,
                     finished_at = COALESCE(finished_at, ?)
                 WHERE id = ? AND phase = ?`,
                [at, id, phase]
            );
            return result.affectedRows === 1;
        },

        async purgeOld(before) {
            await q.execute(
                `DELETE FROM ft_convert_jobs
                 WHERE phase IN ('error', 'canceled', 'expired') AND COALESCE(finished_at, created) < ?`,
                [before]
            );
        },

        async rates() {
            const rows = await q.query<{ quote: string; rate: number | string; as_of: string }>(
                'SELECT quote, rate, as_of FROM ft_convert_fx_rates'
            );
            const rates: Record<string, number> = {};
            for (const row of rows) rates[row.quote] = Number(row.rate);
            return { asOf: rows[0]?.as_of ?? null, rates };
        },

        async saveRates(asOf, rates, at) {
            for (const [quote, rate] of Object.entries(rates)) {
                await q.execute(
                    `INSERT INTO ft_convert_fx_rates (quote, rate, as_of, fetched_at) VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE rate = VALUES(rate), as_of = VALUES(as_of), fetched_at = VALUES(fetched_at)`,
                    [quote, rate, asOf, at]
                );
            }
        },

        async fxState() {
            const rows = await q.query<{ last_attempt_at: number | string; last_success_at: number | string }>(
                'SELECT last_attempt_at, last_success_at FROM ft_convert_fx_state WHERE id = 1'
            );
            return {
                lastAttemptAt: Number(rows[0]?.last_attempt_at ?? 0),
                lastSuccessAt: Number(rows[0]?.last_success_at ?? 0)
            };
        },

        async markFxAttempt(at, success) {
            await q.execute(
                `INSERT INTO ft_convert_fx_state (id, last_attempt_at, last_success_at) VALUES (1, ?, ?)
                 ON DUPLICATE KEY UPDATE last_attempt_at = VALUES(last_attempt_at),
                    last_success_at = IF(?, VALUES(last_success_at), last_success_at)`,
                [at, success ? at : 0, success ? 1 : 0]
            );
        }
    };
}
