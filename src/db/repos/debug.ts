import type { DebugRunKind } from '@deveye/types';
import type { Queryable } from '../pool';

export type DebugRunStatus = 'running' | 'passed' | 'failed' | 'aborted';

export interface DebugRunRow {
    id: number;
    kind: DebugRunKind;
    status: DebugRunStatus;
    /** Millisecondes. */
    started: number;
    finished: number | null;
    /** Le rapport en JSON, tel que la page le lit. */
    report: string;
    launchedBy: { id: number; username: string } | null;
}

export interface TestAccountRow {
    id: number;
    email: string;
    /** `<étiquette d'instance>-<essai>`. */
    run: string;
    /** Secondes. */
    created: number;
}

/** Les essais de la page Tests et débogage, et ce que leurs comptes jetables laissent derrière eux. */
export interface DebugRepo {
    insertRun(input: {
        origin: string;
        kind: DebugRunKind;
        started: number;
        userId: number;
        report: string;
    }): Promise<number>;
    finishRun(id: number, input: { status: DebugRunStatus; finished: number; report: string }): Promise<void>;
    getRun(id: number, origin: string): Promise<DebugRunRow | null>;
    listRuns(origin: string, kind: DebugRunKind, limit: number): Promise<DebugRunRow[]>;
    /** Garde les `keep` plus récents de cette origine et de cette sorte. */
    prune(origin: string, kind: DebugRunKind, keep: number): Promise<void>;
    /** Au démarrage : ce qu'un arrêt a interrompu n'est plus en cours. */
    abortStale(origin: string, finished: number): Promise<number>;
    testAccounts(): Promise<TestAccountRow[]>;
    purgeLogsOf(userIds: readonly number[]): Promise<void>;
    /**
     * Les journaux récents d'un compte d'essai disparu sans passer par le ménage
     * (supprimé par lui-même, puis un plantage) : repérés par son nom dans une
     * ligne, puis effacés en entier pour ce compte.
     */
    purgeOrphanLogsNaming(usernamePrefix: string, sinceSeconds: number): Promise<number>;
    /** Les inscriptions en attente dont l'adresse suit ce motif `LIKE`. */
    purgeSignupsLike(pattern: string): Promise<number>;
}

type Raw = {
    id: number;
    kind: DebugRunKind;
    status: DebugRunStatus;
    started: number;
    finished: number | null;
    report: string;
    user_id: number | null;
    username: string | null;
};

const toRow = (r: Raw): DebugRunRow => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    started: Number(r.started),
    finished: r.finished === null ? null : Number(r.finished),
    report: r.report,
    launchedBy: r.user_id !== null && r.username !== null ? { id: r.user_id, username: r.username } : null
});

const SELECT = `SELECT r.id, r.kind, r.status, r.started, r.finished, r.report, r.user_id, u.username
                FROM debug_runs r LEFT JOIN users u ON u.id = r.user_id`;

export function debugRepo(pool: Queryable): DebugRepo {
    return {
        async insertRun({ origin, kind, started, userId, report }) {
            const r = await pool.query(
                'INSERT INTO debug_runs (origin, kind, started, user_id, report) VALUES (?, ?, ?, ?, ?)',
                [origin, kind, started, userId, report]
            );
            return Number(r.insertId);
        },
        async finishRun(id, { status, finished, report }) {
            await pool.query('UPDATE debug_runs SET status = ?, finished = ?, report = ? WHERE id = ?', [
                status,
                finished,
                report,
                id
            ]);
        },
        async getRun(id, origin) {
            const r = await pool.query<Raw>(`${SELECT} WHERE r.id = ? AND r.origin = ?`, [id, origin]);
            return r.rows[0] ? toRow(r.rows[0]) : null;
        },
        async listRuns(origin, kind, limit) {
            const r = await pool.query<Raw>(`${SELECT} WHERE r.origin = ? AND r.kind = ? ORDER BY r.id DESC LIMIT ?`, [
                origin,
                kind,
                limit
            ]);
            return r.rows.map(toRow);
        },
        async prune(origin, kind, keep) {
            // La sous-requête dérivée contourne le refus de MySQL de lire, dans
            // un DELETE, la table qu'il modifie.
            await pool.query(
                `DELETE FROM debug_runs WHERE origin = ? AND kind = ? AND id NOT IN (
                     SELECT id FROM (
                         SELECT id FROM debug_runs WHERE origin = ? AND kind = ? ORDER BY id DESC LIMIT ?
                     ) AS kept
                 )`,
                [origin, kind, origin, kind, keep]
            );
        },
        async abortStale(origin, finished) {
            const r = await pool.query(
                "UPDATE debug_runs SET status = 'aborted', finished = ? WHERE origin = ? AND status = 'running'",
                [finished, origin]
            );
            return r.rowCount;
        },
        async testAccounts() {
            const r = await pool.query<{ id: number; email: string; e2e_run: string; created: number }>(
                'SELECT id, email, e2e_run, created FROM users WHERE e2e_run IS NOT NULL ORDER BY id'
            );
            return r.rows.map((x) => ({ id: x.id, email: x.email, run: x.e2e_run, created: Number(x.created) }));
        },
        async purgeLogsOf(userIds) {
            if (userIds.length === 0) return;
            await pool.query('DELETE FROM logs WHERE uid IN (?)', [[...userIds]]);
        },
        async purgeOrphanLogsNaming(usernamePrefix, sinceSeconds) {
            const found = await pool.query<{ uid: number }>(
                `SELECT DISTINCT l.uid FROM logs l LEFT JOIN users u ON u.id = l.uid
                 WHERE l.date >= ? AND l.uid > 0 AND u.id IS NULL AND l.description LIKE ?`,
                [sinceSeconds, `%${usernamePrefix}%`]
            );
            const uids = found.rows.map((r) => r.uid);
            if (uids.length === 0) return 0;
            const r = await pool.query('DELETE FROM logs WHERE uid IN (?)', [uids]);
            return r.rowCount;
        },
        async purgeSignupsLike(pattern) {
            const r = await pool.query('DELETE FROM pending_signups WHERE email LIKE ?', [pattern]);
            return r.rowCount;
        }
    };
}
