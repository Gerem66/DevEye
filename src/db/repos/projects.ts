import type { ProjectRow, ProjectSecurityTier, ProjectStatus, ProjectVersionSource } from '@deveye/types';
import type { Queryable } from '../pool';

type Q = Queryable;

/**
 * Compteurs d'un projet, calculés **uniquement sur les colonnes en clair**.
 *
 * C'est ce qui permet au portefeuille d'afficher l'avancement, les retards et
 * les non-lus d'une quarantaine de projets sans déchiffrer une seule ligne — et
 * donc de rester juste même quand un projet gardé est verrouillé.
 */
export interface ProjectStats {
    project_id: number;
    card_total: number;
    card_done: number;
    card_overdue: number;
    next_due_date: number | null;
    unread: number;
}

export interface ProjectsRepo {
    listByWorkspace(workspaceId: number, archived: boolean): Promise<ProjectRow[]>;
    countActiveByWorkspace(workspaceId: number): Promise<number>;
    findById(id: number, workspaceId: number): Promise<ProjectRow | null>;
    create(input: {
        userId: number;
        workspaceId: number;
        status: ProjectStatus;
        securityTier: ProjectSecurityTier;
        startDate: number | null;
        dueDate: number | null;
        content: string;
    }): Promise<ProjectRow>;
    update(
        id: number,
        workspaceId: number,
        input: { status: ProjectStatus; startDate: number | null; dueDate: number | null; content: string }
    ): Promise<ProjectRow | null>;
    setStatus(id: number, workspaceId: number, status: ProjectStatus): Promise<ProjectRow | null>;
    /** Pose la source de version ; le numéro lui-même vit dans `content`. */
    setVersionSource(id: number, workspaceId: number, source: ProjectVersionSource): Promise<ProjectRow | null>;
    /** Bascule le tier **après** que l'arbre a été re-chiffré par l'appelant. */
    setSecurityTier(
        id: number,
        workspaceId: number,
        tier: ProjectSecurityTier,
        content: string
    ): Promise<ProjectRow | null>;
    archive(id: number, workspaceId: number, at: number): Promise<boolean>;
    restore(id: number, workspaceId: number): Promise<boolean>;
    reorder(workspaceId: number, projectIds: number[]): Promise<void>;
    /** Les compteurs de tous les projets d'un espace, pour l'appelant donné. */
    statsByWorkspace(workspaceId: number, userId: number, now: number): Promise<ProjectStats[]>;
}

/** Prochain rang libre à la fin du portefeuille (0 s'il est vide). */
async function nextSortOrder(pool: Q, workspaceId: number): Promise<number> {
    const r = await pool.query<{ next: number }>(
        `SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM projects
         WHERE workspace_id = ? AND archived_at IS NULL`,
        [workspaceId]
    );
    return Number(r.rows[0]?.next ?? 0);
}

export function projectsRepo(pool: Q): ProjectsRepo {
    return {
        async listByWorkspace(workspaceId, archived) {
            // Les deux ensembles sont disjoints : les projets vivants suivent
            // l'ordre choisi, les archivés le plus récemment archivé d'abord.
            const r = await pool.query<ProjectRow>(
                `SELECT * FROM projects
                 WHERE workspace_id = ? AND archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
                 ORDER BY ${archived ? 'archived_at DESC' : 'sort_order ASC'}, id ASC`,
                [workspaceId]
            );
            return r.rows;
        },
        async countActiveByWorkspace(workspaceId) {
            const r = await pool.query<{ count: number }>(
                'SELECT COUNT(*) AS count FROM projects WHERE workspace_id = ? AND archived_at IS NULL',
                [workspaceId]
            );
            return Number(r.rows[0]?.count ?? 0);
        },
        async findById(id, workspaceId) {
            const r = await pool.query<ProjectRow>('SELECT * FROM projects WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return r.rows[0] ?? null;
        },
        async create({ userId, workspaceId, status, securityTier, startDate, dueDate, content }) {
            const sortOrder = await nextSortOrder(pool, workspaceId);
            const res = await pool.query(
                `INSERT INTO projects
                     (workspace_id, user_id, status, security_tier, sort_order, start_date, due_date, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [workspaceId, userId, status, securityTier, sortOrder, startDate, dueDate, content]
            );
            const r = await pool.query<ProjectRow>('SELECT * FROM projects WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async update(id, workspaceId, { status, startDate, dueDate, content }) {
            const res = await pool.query(
                `UPDATE projects SET status = ?, start_date = ?, due_date = ?, content = ?, updated = UNIX_TIMESTAMP()
                 WHERE id = ? AND workspace_id = ?`,
                [status, startDate, dueDate, content, id, workspaceId]
            );
            if (res.rowCount === 0) return null;
            return this.findById(id, workspaceId);
        },
        async setStatus(id, workspaceId, status) {
            const res = await pool.query(
                'UPDATE projects SET status = ?, updated = UNIX_TIMESTAMP() WHERE id = ? AND workspace_id = ?',
                [status, id, workspaceId]
            );
            if (res.rowCount === 0) return null;
            return this.findById(id, workspaceId);
        },
        async setVersionSource(id, workspaceId, source) {
            const res = await pool.query(
                'UPDATE projects SET version_source = ?, updated = UNIX_TIMESTAMP() WHERE id = ? AND workspace_id = ?',
                [source, id, workspaceId]
            );
            if (res.rowCount === 0) return null;
            return this.findById(id, workspaceId);
        },
        async setSecurityTier(id, workspaceId, tier, content) {
            const res = await pool.query(
                `UPDATE projects SET security_tier = ?, content = ?, updated = UNIX_TIMESTAMP()
                 WHERE id = ? AND workspace_id = ?`,
                [tier, content, id, workspaceId]
            );
            if (res.rowCount === 0) return null;
            return this.findById(id, workspaceId);
        },
        async archive(id, workspaceId, at) {
            const r = await pool.query('UPDATE projects SET archived_at = ? WHERE id = ? AND workspace_id = ?', [
                at,
                id,
                workspaceId
            ]);
            return r.rowCount > 0;
        },
        async restore(id, workspaceId) {
            // Son ancien rang appartenait à une liste qui a bougé : on l'ajoute
            // à la fin, comme les notes.
            const sortOrder = await nextSortOrder(pool, workspaceId);
            const r = await pool.query(
                'UPDATE projects SET archived_at = NULL, sort_order = ? WHERE id = ? AND workspace_id = ?',
                [sortOrder, id, workspaceId]
            );
            return r.rowCount > 0;
        },
        async reorder(workspaceId, projectIds) {
            // Chaque id prend le rang de son indice ; seules les lignes de cet
            // espace bougent, un id étranger est donc ignoré en silence.
            // `updated` ne bouge pas : réordonner n'est pas modifier.
            for (let i = 0; i < projectIds.length; i++) {
                await pool.query('UPDATE projects SET sort_order = ? WHERE id = ? AND workspace_id = ?', [
                    i,
                    projectIds[i],
                    workspaceId
                ]);
            }
        },
        async statsByWorkspace(workspaceId, userId, now) {
            // Une seule requête pour tout l'espace plutôt qu'une par projet : le
            // portefeuille en affiche plusieurs dizaines.
            //
            // Les non-lus se comptent contre le point d'eau haute de l'appelant
            // (`project_card_reads`) ; une carte jamais ouverte n'a pas de ligne,
            // d'où le COALESCE à 0 qui compte alors tous ses messages.
            const r = await pool.query<ProjectStats>(
                `SELECT p.id AS project_id,
                        COUNT(c.id)                                             AS card_total,
                        COALESCE(SUM(col.counts_as_done), 0)                    AS card_done,
                        COALESCE(SUM(c.due_date IS NOT NULL
                                     AND c.due_date < ?
                                     AND col.counts_as_done = 0), 0)            AS card_overdue,
                        MIN(CASE WHEN c.due_date >= ? AND col.counts_as_done = 0
                                 THEN c.due_date END)                           AS next_due_date,
                        COALESCE(SUM(GREATEST(
                            c.message_count - COALESCE(seen.seen_count, 0), 0)), 0) AS unread
                 FROM projects p
                 LEFT JOIN project_cards c
                        ON c.project_id = p.id AND c.archived_at IS NULL
                 LEFT JOIN project_columns col
                        ON col.id = c.column_id
                 LEFT JOIN (
                        SELECT m.card_id, COUNT(*) AS seen_count
                        FROM project_messages m
                        JOIN project_card_reads r
                          ON r.card_id = m.card_id AND r.user_id = ?
                        WHERE m.id <= r.last_read_message_id
                        GROUP BY m.card_id
                 ) seen ON seen.card_id = c.id
                 WHERE p.workspace_id = ? AND p.archived_at IS NULL
                 GROUP BY p.id`,
                [now, now, userId, workspaceId]
            );
            return r.rows.map((row) => ({
                project_id: Number(row.project_id),
                card_total: Number(row.card_total),
                card_done: Number(row.card_done),
                card_overdue: Number(row.card_overdue),
                next_due_date: row.next_due_date === null ? null : Number(row.next_due_date),
                unread: Number(row.unread)
            }));
        }
    };
}
