import type { ProjectCardRow, ProjectColumnRow } from '../../contracts/domain';
import type { SdkQueryable } from '@deveye/types/sdk/server';

/** Non-lus d'une carte pour un appelant donné, calculés sans rien déchiffrer. */
export interface CardUnread {
    card_id: number;
    unread: number;
}

/**
 * Les tables `project_columns` et `project_cards` : le tableau d'un projet. Les
 * lectures par projet et toutes les écritures prennent le `workspaceId` du projet,
 * son domicile, qui n'est pas l'espace actif quand le projet est projeté. Les
 * lectures par identifiant seul ne le connaissent pas encore : la ligne porte
 * l'espace de son projet par construction, et c'est le projet, l'élément gardé, que
 * le handler vérifie avant d'agir.
 */
export interface ProjectBoardRepo {
    listColumns(projectId: number, workspaceId: number): Promise<ProjectColumnRow[]>;
    findColumn(columnId: number): Promise<ProjectColumnRow | null>;
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
    /** Nombre de cartes portées par la colonne, archivées comprises. */
    countCardsInColumn(columnId: number, workspaceId: number): Promise<number>;
    deleteColumn(columnId: number, workspaceId: number): Promise<boolean>;
    reorderColumns(projectId: number, workspaceId: number, columnIds: number[]): Promise<void>;

    listCards(projectId: number, workspaceId: number, archived: boolean): Promise<ProjectCardRow[]>;
    findCard(cardId: number): Promise<ProjectCardRow | null>;
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
     * Toutes les cartes vivantes attribuées à quelqu'un dans les projets donnés, en
     * une requête : c'est ce que la colonne claire `assignee_user_id` rend possible.
     */
    listAssignedIn(projectIds: number[], userId: number): Promise<ProjectCardRow[]>;
}

/** Prochain rang libre à la fin d'une colonne (0 quand elle est vide). */
async function nextCardOrder(q: SdkQueryable, columnId: number): Promise<number> {
    const rows = await q.query<{ next: number }>(
        `SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM project_cards
         WHERE column_id = ? AND archived_at IS NULL`,
        [columnId]
    );
    return Number(rows[0]?.next ?? 0);
}

export function projectBoardRepo(q: SdkQueryable): ProjectBoardRepo {
    return {
        async listColumns(projectId, workspaceId) {
            return q.query<ProjectColumnRow>(
                `SELECT * FROM project_columns WHERE project_id = ? AND workspace_id = ?
                 ORDER BY sort_order ASC, id ASC`,
                [projectId, workspaceId]
            );
        },
        async findColumn(columnId) {
            const rows = await q.query<ProjectColumnRow>('SELECT * FROM project_columns WHERE id = ?', [columnId]);
            return rows[0] ?? null;
        },
        async createColumn({ projectId, workspaceId, content, countsAsDone = false }) {
            const next = await q.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM project_columns WHERE project_id = ?',
                [projectId]
            );
            const res = await q.execute(
                `INSERT INTO project_columns (project_id, workspace_id, sort_order, counts_as_done, content)
                 VALUES (?, ?, ?, ?, ?)`,
                [projectId, workspaceId, Number(next[0]?.next ?? 0), countsAsDone ? 1 : 0, content]
            );
            const rows = await q.query<ProjectColumnRow>('SELECT * FROM project_columns WHERE id = ?', [res.insertId]);
            return rows[0];
        },
        async updateColumn(columnId, workspaceId, { content, countsAsDone, wipLimit }) {
            const res = await q.execute(
                `UPDATE project_columns SET content = ?, counts_as_done = ?, wip_limit = ?
                 WHERE id = ? AND workspace_id = ?`,
                [content, countsAsDone ? 1 : 0, wipLimit, columnId, workspaceId]
            );
            if (res.affectedRows === 0) return null;
            return this.findColumn(columnId);
        },
        async countCardsInColumn(columnId, workspaceId) {
            // Archivées comprises : la contrainte SQL les emporterait avec la
            // colonne.
            const rows = await q.query<{ count: number }>(
                'SELECT COUNT(*) AS count FROM project_cards WHERE column_id = ? AND workspace_id = ?',
                [columnId, workspaceId]
            );
            return Number(rows[0]?.count ?? 0);
        },
        async deleteColumn(columnId, workspaceId) {
            const res = await q.execute('DELETE FROM project_columns WHERE id = ? AND workspace_id = ?', [
                columnId,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async reorderColumns(projectId, workspaceId, columnIds) {
            for (let i = 0; i < columnIds.length; i++) {
                await q.execute(
                    'UPDATE project_columns SET sort_order = ? WHERE id = ? AND project_id = ? AND workspace_id = ?',
                    [i, columnIds[i], projectId, workspaceId]
                );
            }
        },

        async listCards(projectId, workspaceId, archived) {
            return q.query<ProjectCardRow>(
                `SELECT * FROM project_cards
                 WHERE project_id = ? AND workspace_id = ? AND archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
                 ORDER BY ${archived ? 'archived_at DESC' : 'sort_order ASC'}, id ASC`,
                [projectId, workspaceId]
            );
        },
        async findCard(cardId) {
            const rows = await q.query<ProjectCardRow>('SELECT * FROM project_cards WHERE id = ?', [cardId]);
            return rows[0] ?? null;
        },
        async createCard(input) {
            const sortOrder = await nextCardOrder(q, input.columnId);
            const res = await q.execute(
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
            const rows = await q.query<ProjectCardRow>('SELECT * FROM project_cards WHERE id = ?', [res.insertId]);
            return rows[0];
        },
        async updateCard(cardId, workspaceId, input) {
            const res = await q.execute(
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
            if (res.affectedRows === 0) return null;
            return this.findCard(cardId);
        },
        async moveCards(workspaceId, columnId, cardIds) {
            // `updated` ne bouge pas, ranger une carte n'est pas la modifier. Une
            // carte d'un autre espace est ignorée en silence par le WHERE.
            for (let i = 0; i < cardIds.length; i++) {
                await q.execute(
                    'UPDATE project_cards SET column_id = ?, sort_order = ? WHERE id = ? AND workspace_id = ?',
                    [columnId, i, cardIds[i], workspaceId]
                );
            }
        },
        async archiveCard(cardId, workspaceId, at) {
            const res = await q.execute('UPDATE project_cards SET archived_at = ? WHERE id = ? AND workspace_id = ?', [
                at,
                cardId,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async restoreCard(cardId, workspaceId) {
            const existing = await this.findCard(cardId);
            if (!existing || existing.workspace_id !== workspaceId) return false;
            // Son ancien rang appartenait à une colonne qui a bougé : elle repart de
            // la fin.
            const sortOrder = await nextCardOrder(q, existing.column_id);
            const res = await q.execute(
                'UPDATE project_cards SET archived_at = NULL, sort_order = ? WHERE id = ? AND workspace_id = ?',
                [sortOrder, cardId, workspaceId]
            );
            return res.affectedRows > 0;
        },

        async listAssignedIn(projectIds, userId) {
            if (projectIds.length === 0) return [];
            // Les tâches sans échéance en dernier, puis les plus urgentes : l'ordre
            // dans lequel on lit sa propre liste.
            const placeholders = projectIds.map(() => '?').join(', ');
            return q.query<ProjectCardRow>(
                `SELECT c.* FROM project_cards c
                 WHERE c.project_id IN (${placeholders}) AND c.assignee_user_id = ? AND c.archived_at IS NULL
                 ORDER BY c.due_date IS NULL, c.due_date ASC, c.priority DESC, c.id ASC`,
                [...projectIds, userId]
            );
        },
        async unreadByProject(projectId, workspaceId, userId) {
            // Un COUNT contre le point d'eau haute de l'appelant. Une carte jamais
            // ouverte n'a pas de ligne de lecture, tous ses messages comptent alors
            // comme non lus : d'où le LEFT JOIN.
            const rows = await q.query<CardUnread>(
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
            return rows.map((row) => ({ card_id: Number(row.card_id), unread: Number(row.unread) }));
        }
    };
}
