import type { ConvertRepo, JobRow, StoredRates } from './repo';

/**
 * Le dépôt en mémoire des tests. Il tient les mêmes gardes que le SQL : une
 * transition ne passe que depuis l'état attendu, c'est ce que les tests exercent.
 */
export interface MemoryRepo extends ConvertRepo {
    rows: JobRow[];
    stored: StoredRates;
    fx: { lastAttemptAt: number; lastSuccessAt: number };
}

export function memoryRepo(): MemoryRepo {
    const rows: JobRow[] = [];
    const byId = (id: number): JobRow | undefined => rows.find((r) => r.id === id);
    const holding = new Set(['awaiting_upload', 'uploading', 'queued', 'running', 'done']);

    const repo: MemoryRepo = {
        rows,
        stored: { asOf: null, rates: {} },
        fx: { lastAttemptAt: 0, lastSuccessAt: 0 },

        insert(job) {
            const id = rows.length + 1;
            rows.push({
                id,
                workspace_id: job.workspaceId,
                user_id: job.userId,
                kind: job.kind,
                source_format: job.sourceFormat,
                target_format: job.targetFormat,
                options: JSON.stringify(job.options),
                original_name_enc: job.originalNameEnc,
                input_bytes: job.declaredBytes,
                output_bytes: null,
                phase: 'awaiting_upload',
                progress_permille: 0,
                attempts: 0,
                error_code: null,
                error_enc: null,
                created: job.at,
                started_at: null,
                finished_at: null,
                expires_at: null
            });
            return Promise.resolve(id);
        },
        find: (id, workspaceId) =>
            Promise.resolve(rows.find((r) => r.id === id && r.workspace_id === workspaceId) ?? null),
        list: (workspaceId, userId, limit) =>
            Promise.resolve(
                rows
                    .filter((r) => r.workspace_id === workspaceId && r.user_id === userId)
                    .filter((r) => r.phase !== 'canceled' && r.phase !== 'expired')
                    .slice(-limit)
                    .reverse()
            ),
        heldBytes: (workspaceId) =>
            Promise.resolve(
                rows
                    .filter((r) => r.workspace_id === workspaceId && holding.has(r.phase))
                    .reduce((sum, r) => sum + Number(r.phase === 'done' ? (r.output_bytes ?? 0) : r.input_bytes), 0)
            ),
        openJobs: (workspaceIds) =>
            Promise.resolve(
                rows.filter(
                    (r) =>
                        workspaceIds.includes(r.workspace_id) &&
                        ['awaiting_upload', 'uploading', 'queued', 'running'].includes(r.phase)
                ).length
            ),
        resultBytes: (workspaceIds) =>
            Promise.resolve(
                rows
                    .filter((r) => workspaceIds.includes(r.workspace_id) && r.phase === 'done')
                    .reduce((sum, r) => sum + Number(r.output_bytes ?? 0), 0)
            ),
        claimForUpload(id, workspaceId) {
            const row = byId(id);
            if (!row || row.workspace_id !== workspaceId || row.phase !== 'awaiting_upload')
                return Promise.resolve(null);
            row.phase = 'uploading';
            return Promise.resolve(row);
        },
        queue(id, inputBytes) {
            const row = byId(id);
            if (row?.phase === 'uploading') Object.assign(row, { phase: 'queued', input_bytes: inputBytes });
            return Promise.resolve();
        },
        claimQueued(at) {
            const row = rows.find((r) => r.phase === 'queued');
            if (!row) return Promise.resolve(null);
            Object.assign(row, { phase: 'running', started_at: at, attempts: row.attempts + 1 });
            return Promise.resolve(row);
        },
        progress(id, permille) {
            const row = byId(id);
            if (row?.phase === 'running') row.progress_permille = permille;
            return Promise.resolve();
        },
        finish(id, outputBytes, at, expiresAt) {
            const row = byId(id);
            if (row?.phase === 'running') {
                Object.assign(row, {
                    phase: 'done',
                    output_bytes: outputBytes,
                    finished_at: at,
                    expires_at: expiresAt
                });
            }
            return Promise.resolve();
        },
        fail(id, code, errorEnc, at) {
            const row = byId(id);
            if (row && ['uploading', 'queued', 'running'].includes(row.phase)) {
                Object.assign(row, { phase: 'error', error_code: code, error_enc: errorEnc, finished_at: at });
            }
            return Promise.resolve();
        },
        cancel(id, workspaceId, at) {
            const row = byId(id);
            const open = ['awaiting_upload', 'uploading', 'queued', 'running'];
            if (!row || row.workspace_id !== workspaceId || !open.includes(row.phase)) return Promise.resolve(false);
            Object.assign(row, { phase: 'canceled', finished_at: at });
            return Promise.resolve(true);
        },
        remove(id, workspaceId) {
            const index = rows.findIndex((r) => r.id === id && r.workspace_id === workspaceId);
            if (index === -1 || !['done', 'error', 'canceled', 'expired'].includes(rows[index].phase)) {
                return Promise.resolve(false);
            }
            rows.splice(index, 1);
            return Promise.resolve(true);
        },
        recoverStale(maxAttempts, at) {
            let requeued = 0;
            for (const row of rows) {
                if (row.phase === 'uploading') {
                    Object.assign(row, { phase: 'error', error_code: 'upload_interrupted', finished_at: at });
                } else if (row.phase === 'running' && row.attempts >= maxAttempts) {
                    Object.assign(row, { phase: 'error', error_code: 'interrupted', finished_at: at });
                } else if (row.phase === 'running') {
                    row.phase = 'queued';
                    requeued++;
                }
            }
            return Promise.resolve(requeued);
        },
        expire(at, uploadsBefore) {
            const due = rows.filter(
                (r) =>
                    (r.phase === 'done' && Number(r.expires_at) <= at) ||
                    (r.phase === 'awaiting_upload' && Number(r.created) < uploadsBefore)
            );
            for (const row of due) row.phase = 'expired';
            return Promise.resolve(due.map((r) => ({ id: r.id, workspaceId: r.workspace_id })));
        },
        liveKeys: () =>
            Promise.resolve(new Set(rows.filter((r) => holding.has(r.phase)).map((r) => `${r.workspace_id}/${r.id}`))),
        promisingFile: () =>
            Promise.resolve(
                rows
                    .filter((r) => r.phase === 'queued' || r.phase === 'done')
                    .map((r) => ({ id: r.id, workspaceId: r.workspace_id, phase: r.phase as 'queued' | 'done' }))
            ),
        markLost(id, phase, at) {
            const row = byId(id);
            if (row?.phase !== phase) return Promise.resolve(false);
            Object.assign(row, {
                phase: 'error',
                error_code: 'file_lost',
                error_enc: null,
                expires_at: null,
                finished_at: row.finished_at ?? at
            });
            return Promise.resolve(true);
        },
        purgeOld: () => Promise.resolve(),
        rates: () => Promise.resolve(repo.stored),
        saveRates(asOf, rates) {
            repo.stored = { asOf, rates: { ...rates } };
            return Promise.resolve();
        },
        fxState: () => Promise.resolve(repo.fx),
        markFxAttempt(at, success) {
            repo.fx = { lastAttemptAt: at, lastSuccessAt: success ? at : repo.fx.lastSuccessAt };
            return Promise.resolve();
        }
    };
    return repo;
}
