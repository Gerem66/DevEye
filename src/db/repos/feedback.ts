import { feedbackSnapshotSchema, type FeedbackEntry, type FeedbackKind, type FeedbackStatus } from '@deveye/types';
import { selectColumns } from '../columns';
import type { Queryable } from '../pool';

type Q = Queryable;

/** Un signalement à écrire. Tout ce qui identifie vient de la session, pas du client. */
export interface RecordFeedbackInput {
    uid: number;
    workspaceId: number | null;
    kind: FeedbackKind;
    message: string;
    /** Le rapport technique, déjà validé. `null` pour un retour libre. */
    snapshot: unknown | null;
    ip: string;
    appVersion: string;
}

/** Filtre combiné en ET pour {@link FeedbackRepo.query} ; chaque champ est optionnel. */
export interface FeedbackQueryFilter {
    kind?: FeedbackKind;
    status?: FeedbackStatus;
    uid?: number;
    /** Sous-chaîne insensible à la casse, sur le message. */
    search?: string;
}

export interface FeedbackPage {
    entries: FeedbackEntry[];
    /** Nombre de lignes correspondant au filtre, pagination ignorée. */
    total: number;
    /** Signalements encore intacts, quel que soit le filtre. */
    pending: number;
}

export interface FeedbackRepo {
    record(input: RecordFeedbackInput): Promise<number>;
    query(filter: FeedbackQueryFilter, paging: { limit: number; offset: number }): Promise<FeedbackPage>;
    findById(id: number): Promise<FeedbackEntry | null>;
    setStatus(id: number, status: FeedbackStatus, handledBy: number): Promise<boolean>;
    remove(id: number): Promise<boolean>;
    /** Envois d'un compte depuis cet instant (unix secondes) : borne l'abus. */
    countSince(uid: number, since: number): Promise<number>;
}

/** Ligne du listage, jointe aux comptes pour les noms affichés. */
export interface FeedbackJoinRow {
    id: number;
    created: number;
    kind: string;
    status: string;
    uid: number;
    username: string | null;
    workspace_id: number | null;
    message: string;
    snapshot: unknown;
    ip: string;
    app_version: string;
    handled_at: number | null;
    handled_by: number | null;
    handled_by_name: string | null;
}

/**
 * Le rapport tel qu'il est relu. Un rapport que le schéma courant ne reconnaît
 * plus vaut `null` : une ligne reste lisible même quand ce qu'elle transportait
 * ne l'est plus, et le message de l'utilisateur ne se perd pas avec.
 */
function parseSnapshot(raw: unknown): FeedbackEntry['snapshot'] {
    if (raw === null || raw === undefined) return null;
    const value: unknown = typeof raw === 'string' ? safeJson(raw) : raw;
    const parsed = feedbackSnapshotSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function safeJson(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function toEntry(r: FeedbackJoinRow): FeedbackEntry {
    return {
        id: r.id,
        created: Number(r.created),
        kind: r.kind as FeedbackKind,
        status: r.status as FeedbackStatus,
        uid: r.uid,
        username: r.username ?? null,
        workspaceId: r.workspace_id,
        message: r.message,
        ip: r.ip,
        appVersion: r.app_version,
        snapshot: parseSnapshot(r.snapshot),
        handledAt: r.handled_at === null ? null : Number(r.handled_at),
        handledBy: r.handled_by,
        handledByName: r.handled_by_name ?? null
    };
}

const SELECT_COLUMNS = selectColumns<FeedbackJoinRow>('f', {
    id: true,
    created: true,
    kind: true,
    status: true,
    uid: true,
    username: 'u.username',
    workspace_id: true,
    message: true,
    snapshot: true,
    ip: true,
    app_version: true,
    handled_at: true,
    handled_by: true,
    handled_by_name: 'h.username'
});

const FROM_JOINED = `FROM feedback f
                     LEFT JOIN users u ON u.id = f.uid
                     LEFT JOIN users h ON h.id = f.handled_by`;

/** Clause WHERE partagée et ses paramètres liés. */
function buildWhere(filter: FeedbackQueryFilter): { where: string; params: unknown[] } {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.kind !== undefined) {
        conds.push('f.kind = ?');
        params.push(filter.kind);
    }
    if (filter.status !== undefined) {
        conds.push('f.status = ?');
        params.push(filter.status);
    }
    if (filter.uid !== undefined) {
        conds.push('f.uid = ?');
        params.push(filter.uid);
    }
    if (filter.search) {
        conds.push('f.message LIKE ?');
        params.push(`%${filter.search}%`);
    }
    return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

export function feedbackRepo(pool: Q): FeedbackRepo {
    return {
        async record({ uid, workspaceId, kind, message, snapshot, ip, appVersion }) {
            const res = await pool.query(
                `INSERT INTO feedback (uid, workspace_id, kind, message, snapshot, ip, app_version)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [uid, workspaceId, kind, message, snapshot === null ? null : JSON.stringify(snapshot), ip, appVersion]
            );
            return res.insertId;
        },

        async query(filter, { limit, offset }) {
            const { where, params } = buildWhere(filter);

            const [countRes, pendingRes, rows] = await Promise.all([
                pool.query<{ total: number }>(`SELECT COUNT(*) AS total FROM feedback f ${where}`, params),
                pool.query<{ pending: number }>(`SELECT COUNT(*) AS pending FROM feedback WHERE status = 'new'`),
                pool.query<FeedbackJoinRow>(
                    `SELECT ${SELECT_COLUMNS}
                     ${FROM_JOINED}
                     ${where}
                     ORDER BY f.created DESC, f.id DESC
                     LIMIT ? OFFSET ?`,
                    [...params, limit, offset]
                )
            ]);

            return {
                entries: rows.rows.map(toEntry),
                total: Number(countRes.rows[0]?.total ?? 0),
                pending: Number(pendingRes.rows[0]?.pending ?? 0)
            };
        },

        async findById(id) {
            const rows = await pool.query<FeedbackJoinRow>(`SELECT ${SELECT_COLUMNS} ${FROM_JOINED} WHERE f.id = ?`, [
                id
            ]);
            const row = rows.rows[0];
            return row ? toEntry(row) : null;
        },

        async setStatus(id, status, handledBy) {
            // `handled_at` retombe à NULL quand la ligne repart en « nouveau » :
            // la date de traitement ne survit pas au traitement.
            const res = await pool.query(
                `UPDATE feedback
                 SET status = ?,
                     handled_at = IF(? = 'new', NULL, UNIX_TIMESTAMP()),
                     handled_by = IF(? = 'new', NULL, ?)
                 WHERE id = ?`,
                [status, status, status, handledBy, id]
            );
            return res.rowCount > 0;
        },

        async remove(id) {
            const res = await pool.query('DELETE FROM feedback WHERE id = ?', [id]);
            return res.rowCount > 0;
        },

        async countSince(uid, since) {
            const res = await pool.query<{ total: number }>(
                'SELECT COUNT(*) AS total FROM feedback WHERE uid = ? AND created >= ?',
                [uid, since]
            );
            return Number(res.rows[0]?.total ?? 0);
        }
    };
}
