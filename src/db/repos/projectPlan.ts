import type { ProjectCardDepRow, ProjectMilestoneRow } from '@deveye/types';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface ProjectPlanRepo {
    listMilestones(projectId: number, workspaceId: number): Promise<ProjectMilestoneRow[]>;
    findMilestone(milestoneId: number, workspaceId: number): Promise<ProjectMilestoneRow | null>;
    createMilestone(input: {
        projectId: number;
        workspaceId: number;
        dueDate: number;
        content: string;
    }): Promise<ProjectMilestoneRow>;
    updateMilestone(
        milestoneId: number,
        workspaceId: number,
        input: { dueDate: number; content: string }
    ): Promise<ProjectMilestoneRow | null>;
    setMilestoneReached(
        milestoneId: number,
        workspaceId: number,
        reachedAt: number | null
    ): Promise<ProjectMilestoneRow | null>;
    deleteMilestone(milestoneId: number, workspaceId: number): Promise<boolean>;
    /** Rattache une carte à un jalon (ou l'en détache avec `null`). */
    setCardMilestone(cardId: number, workspaceId: number, milestoneId: number | null): Promise<boolean>;

    /** Toutes les arêtes du projet — c'est ce qui rend la détection de cycle locale. */
    listDeps(projectId: number): Promise<ProjectCardDepRow[]>;
    addDep(cardId: number, blockedByCardId: number, projectId: number): Promise<void>;
    removeDep(cardId: number, blockedByCardId: number): Promise<boolean>;
}

export function projectPlanRepo(pool: Q): ProjectPlanRepo {
    return {
        async listMilestones(projectId, workspaceId) {
            const r = await pool.query<ProjectMilestoneRow>(
                `SELECT * FROM project_milestones WHERE project_id = ? AND workspace_id = ?
                 ORDER BY due_date ASC, id ASC`,
                [projectId, workspaceId]
            );
            return r.rows;
        },
        async findMilestone(milestoneId, workspaceId) {
            const r = await pool.query<ProjectMilestoneRow>(
                'SELECT * FROM project_milestones WHERE id = ? AND workspace_id = ?',
                [milestoneId, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async createMilestone({ projectId, workspaceId, dueDate, content }) {
            const next = await pool.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM project_milestones WHERE project_id = ?',
                [projectId]
            );
            const res = await pool.query(
                `INSERT INTO project_milestones (project_id, workspace_id, due_date, sort_order, content)
                 VALUES (?, ?, ?, ?, ?)`,
                [projectId, workspaceId, dueDate, Number(next.rows[0]?.next ?? 0), content]
            );
            const r = await pool.query<ProjectMilestoneRow>('SELECT * FROM project_milestones WHERE id = ?', [
                res.insertId
            ]);
            return r.rows[0];
        },
        async updateMilestone(milestoneId, workspaceId, { dueDate, content }) {
            const res = await pool.query(
                'UPDATE project_milestones SET due_date = ?, content = ? WHERE id = ? AND workspace_id = ?',
                [dueDate, content, milestoneId, workspaceId]
            );
            if (res.rowCount === 0) return null;
            return this.findMilestone(milestoneId, workspaceId);
        },
        async setMilestoneReached(milestoneId, workspaceId, reachedAt) {
            const res = await pool.query(
                'UPDATE project_milestones SET reached_at = ? WHERE id = ? AND workspace_id = ?',
                [reachedAt, milestoneId, workspaceId]
            );
            if (res.rowCount === 0) return null;
            return this.findMilestone(milestoneId, workspaceId);
        },
        async deleteMilestone(milestoneId, workspaceId) {
            const r = await pool.query('DELETE FROM project_milestones WHERE id = ? AND workspace_id = ?', [
                milestoneId,
                workspaceId
            ]);
            return r.rowCount > 0;
        },
        async setCardMilestone(cardId, workspaceId, milestoneId) {
            const r = await pool.query('UPDATE project_cards SET milestone_id = ? WHERE id = ? AND workspace_id = ?', [
                milestoneId,
                cardId,
                workspaceId
            ]);
            return r.rowCount > 0;
        },

        async listDeps(projectId) {
            const r = await pool.query<ProjectCardDepRow>('SELECT * FROM project_card_deps WHERE project_id = ?', [
                projectId
            ]);
            return r.rows;
        },
        async addDep(cardId, blockedByCardId, projectId) {
            // `IGNORE` : la paire est la clé primaire, la reposer n'est pas une
            // erreur — c'est le même fait, déclaré deux fois.
            await pool.query(
                'INSERT IGNORE INTO project_card_deps (card_id, blocked_by_card_id, project_id) VALUES (?, ?, ?)',
                [cardId, blockedByCardId, projectId]
            );
        },
        async removeDep(cardId, blockedByCardId) {
            const r = await pool.query('DELETE FROM project_card_deps WHERE card_id = ? AND blocked_by_card_id = ?', [
                cardId,
                blockedByCardId
            ]);
            return r.rowCount > 0;
        }
    };
}
