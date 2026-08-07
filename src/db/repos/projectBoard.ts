import type { ProjectCardRow, ProjectColumnRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/** Non-lus d'une carte pour un appelant donné, calculés sans rien déchiffrer. */
export interface CardUnread {
    card_id: number;
    unread: number;
}

export interface ProjectBoardRepo {
    listColumns(projectId: number, workspaceId: number): Promise<ProjectColumnRow[]>;
    findColumn(columnId: number, workspaceId: number): Promise<ProjectColumnRow | null>;
    createColumn(input: {
        projectId: number;
        workspaceId: number;
        content: string;
        countsAsDone?: boolean;
    }): Promise<ProjectColumnRow>;
    updateColumn(
        columnId: number,
        workspaceId: number,
        input: { content: string; countsAsDone: boolean; wipLimit: number | null }
    ): Promise<ProjectColumnRow | null>;
    /** Nombre de cartes portées par la colonne, **archivées comprises**. */
    countCardsInColumn(columnId: number, workspaceId: number): Promise<number>;
    deleteColumn(columnId: number, workspaceId: number): Promise<boolean>;
    reorderColumns(projectId: number, workspaceId: number, columnIds: number[]): Promise<void>;

    listCards(projectId: number, workspaceId: number, archived: boolean): Promise<ProjectCardRow[]>;
    findCard(cardId: number, workspaceId: number): Promise<ProjectCardRow | null>;
    createCard(input: {
        projectId: number;
        workspaceId: number;
        columnId: number;
        authorUserId: number;
        assigneeUserId: number | null;
        priority: number;
        startDate: number | null;
        dueDate: number | null;
        estimateMinutes: number | null;
        content: string;
    }): Promise<ProjectCardRow>;
    updateCard(
        cardId: number,
        workspaceId: number,
        input: {
            assigneeUserId: number | null;
            priority: number;
            startDate: number | null;
            dueDate: number | null;
            estimateMinutes: number | null;
            content: string;
        }
    ): Promise<ProjectCardRow | null>;
    /** Verse chaque carte listée dans `columnId` et la range à son indice. */
    moveCards(workspaceId: number, columnId: number, cardIds: number[]): Promise<void>;
    archiveCard(cardId: number, workspaceId: number, at: number): Promise<boolean>;
    restoreCard(cardId: number, workspaceId: number): Promise<boolean>;

    unreadByProject(projectId: number, workspaceId: number, userId: number): Promise<CardUnread[]>;
    /**
     * Toutes les cartes vivantes attribuées à quelqu'un, **tous projets de
     * l'espace confondus**. Une seule requête : c'est exactement ce que la
     * colonne claire `assignee_user_id` sert à rendre possible.
     */
    listAssignedTo(workspaceId: number, userId: number): Promise<ProjectCardRow[]>;
}

/** Prochain rang libre à la fin d'une colonne (0 quand elle est vide). */
async function nextCardOrder(pool: Q, columnId: number): Promise<number> {
    const r = await pool.query<{ next: number }>(
        `SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM project_cards
         WHERE column_id = ? AND archived_at IS NULL`,
        [columnId]
    );
    return Number(r.rows[0]?.next ?? 0);
}

export function projectBoardRepo(pool: Q): ProjectBoardRepo {
    return {
        async listColumns(projectId, workspaceId) {
            const r = await pool.query<ProjectColumnRow>(
                `SELECT * FROM project_columns WHERE project_id = ? AND workspace_id = ?
                 ORDER BY sort_order ASC, id ASC`,
                [projectId, workspaceId]
            );
            return r.rows;
        },
        async findColumn(columnId, workspaceId) {
            const r = await pool.query<ProjectColumnRow>(
                'SELECT * FROM project_columns WHERE id = ? AND workspace_id = ?',
                [columnId, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async createColumn({ projectId, workspaceId, content, countsAsDone = false }) {
            const next = await pool.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM project_columns WHERE project_id = ?',
                [projectId]
            );
            const res = await pool.query(
                `INSERT INTO project_columns (project_id, workspace_id, sort_order, counts_as_done, content)
                 VALUES (?, ?, ?, ?, ?)`,
                [projectId, workspaceId, Number(next.rows[0]?.next ?? 0), countsAsDone ? 1 : 0, content]
            );
            const r = await pool.query<ProjectColumnRow>('SELECT * FROM project_columns WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async updateColumn(columnId, workspaceId, { content, countsAsDone, wipLimit }) {
            const res = await pool.query(
                `UPDATE project_columns SET content = ?, counts_as_done = ?, wip_limit = ?
                 WHERE id = ? AND workspace_id = ?`,
                [content, countsAsDone ? 1 : 0, wipLimit, columnId, workspaceId]
            );
            if (res.rowCount === 0) return null;
            return this.findColumn(columnId, workspaceId);
        },
        async countCardsInColumn(columnId, workspaceId) {
            // Archivées comprises : elles sont toujours là, et la contrainte SQL
            // les emporterait avec la colonne.
            const r = await pool.query<{ count: number }>(
                'SELECT COUNT(*) AS count FROM project_cards WHERE column_id = ? AND workspace_id = ?',
                [columnId, workspaceId]
            );
            return Number(r.rows[0]?.count ?? 0);
        },
        async deleteColumn(columnId, workspaceId) {
            const r = await pool.query('DELETE FROM project_columns WHERE id = ? AND workspace_id = ?', [
                columnId,
                workspaceId
            ]);
            return r.rowCount > 0;
        },
        async reorderColumns(projectId, workspaceId, columnIds) {
            for (let i = 0; i < columnIds.length; i++) {
                await pool.query(
                    'UPDATE project_columns SET sort_order = ? WHERE id = ? AND project_id = ? AND workspace_id = ?',
                    [i, columnIds[i], projectId, workspaceId]
                );
            }
        },

        async listCards(projectId, workspaceId, archived) {
            const r = await pool.query<ProjectCardRow>(
                `SELECT * FROM project_cards
                 WHERE project_id = ? AND workspace_id = ? AND archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
                 ORDER BY ${archived ? 'archived_at DESC' : 'sort_order ASC'}, id ASC`,
                [projectId, workspaceId]
            );
            return r.rows;
        },
        async findCard(cardId, workspaceId) {
            const r = await pool.query<ProjectCardRow>(
                'SELECT * FROM project_cards WHERE id = ? AND workspace_id = ?',
                [cardId, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async createCard(input) {
            const sortOrder = await nextCardOrder(pool, input.columnId);
            const res = await pool.query(
                `INSERT INTO project_cards
                     (project_id, workspace_id, column_id, sort_order, author_user_id, assignee_user_id,
                      priority, start_date, due_date, estimate_minutes, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    input.projectId,
                    input.workspaceId,
                    input.columnId,
                    sortOrder,
                    input.authorUserId,
                    input.assigneeUserId,
                    input.priority,
                    input.startDate,
                    input.dueDate,
                    input.estimateMinutes,
                    input.content
                ]
            );
            const r = await pool.query<ProjectCardRow>('SELECT * FROM project_cards WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async updateCard(cardId, workspaceId, input) {
            const res = await pool.query(
                `UPDATE project_cards SET assignee_user_id = ?, priority = ?, start_date = ?, due_date = ?,
                        estimate_minutes = ?, content = ?, updated = UNIX_TIMESTAMP()
                 WHERE id = ? AND workspace_id = ?`,
                [
                    input.assigneeUserId,
                    input.priority,
                    input.startDate,
                    input.dueDate,
                    input.estimateMinutes,
                    input.content,
                    cardId,
                    workspaceId
                ]
            );
            if (res.rowCount === 0) return null;
            return this.findCard(cardId, workspaceId);
        },
        async moveCards(workspaceId, columnId, cardIds) {
            // `updated` ne bouge pas : ranger une carte n'est pas la modifier.
            // Une carte d'un autre espace est ignorée en silence par le WHERE.
            for (let i = 0; i < cardIds.length; i++) {
                await pool.query(
                    'UPDATE project_cards SET column_id = ?, sort_order = ? WHERE id = ? AND workspace_id = ?',
                    [columnId, i, cardIds[i], workspaceId]
                );
            }
        },
        async archiveCard(cardId, workspaceId, at) {
            const r = await pool.query('UPDATE project_cards SET archived_at = ? WHERE id = ? AND workspace_id = ?', [
                at,
                cardId,
                workspaceId
            ]);
            return r.rowCount > 0;
        },
        async restoreCard(cardId, workspaceId) {
            const existing = await this.findCard(cardId, workspaceId);
            if (!existing) return false;
            // Son ancien rang appartenait à une colonne qui a bougé : on l'ajoute
            // à la fin, comme les notes restaurées.
            const sortOrder = await nextCardOrder(pool, existing.column_id);
            const r = await pool.query(
                'UPDATE project_cards SET archived_at = NULL, sort_order = ? WHERE id = ? AND workspace_id = ?',
                [sortOrder, cardId, workspaceId]
            );
            return r.rowCount > 0;
        },

        async listAssignedTo(workspaceId, userId) {
            // Les tâches sans échéance en dernier, puis les plus urgentes : c'est
            // l'ordre dans lequel on veut lire sa propre liste.
            const r = await pool.query<ProjectCardRow>(
                `SELECT c.* FROM project_cards c
                 JOIN projects p ON p.id = c.project_id
                 WHERE c.workspace_id = ? AND c.assignee_user_id = ?
                   AND c.archived_at IS NULL AND p.archived_at IS NULL
                 ORDER BY c.due_date IS NULL, c.due_date ASC, c.priority DESC, c.id ASC`,
                [workspaceId, userId]
            );
            return r.rows;
        },
        async unreadByProject(projectId, workspaceId, userId) {
            // Un COUNT contre le point d'eau haute de l'appelant. Une carte
            // jamais ouverte n'a pas de ligne de lecture : tous ses messages
            // comptent alors comme non lus, d'où le LEFT JOIN.
            const r = await pool.query<CardUnread>(
                `SELECT c.id AS card_id,
                        COUNT(m.id) AS unread
                 FROM project_cards c
                 LEFT JOIN project_card_reads r ON r.card_id = c.id AND r.user_id = ?
                 LEFT JOIN project_messages m
                        ON m.card_id = c.id AND m.id > COALESCE(r.last_read_message_id, 0)
                 WHERE c.project_id = ? AND c.workspace_id = ? AND c.archived_at IS NULL
                 GROUP BY c.id`,
                [userId, projectId, workspaceId]
            );
            return r.rows.map((row) => ({ card_id: Number(row.card_id), unread: Number(row.unread) }));
        }
    };
}
