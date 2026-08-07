import type { ProjectDeployTargetRow, ProjectDeploymentRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface ProjectDeployRepo {
    findTarget(projectId: number, workspaceId: number): Promise<ProjectDeployTargetRow | null>;
    upsertTarget(input: {
        projectId: number;
        workspaceId: number;
        credentialId: number;
        provider: string;
        externalId: string;
        content: string;
    }): Promise<ProjectDeployTargetRow>;
    deleteTarget(projectId: number, workspaceId: number): Promise<boolean>;

    createDeployment(input: {
        projectId: number;
        workspaceId: number;
        provider: string;
        externalId: string | null;
        triggeredByUserId: number;
        content: string;
    }): Promise<ProjectDeploymentRow>;
    updateDeployment(
        id: number,
        input: { externalId: string | null; status: string; finishedAt: number | null; content: string }
    ): Promise<void>;
    listDeployments(projectId: number, workspaceId: number, limit: number): Promise<ProjectDeploymentRow[]>;
    /**
     * Les déploiements encore en vol, tous projets confondus : c'est ce que
     * l'ordonnanceur doit aller réinterroger chez le fournisseur.
     */
    listInFlight(limit: number): Promise<ProjectDeploymentRow[]>;
}

export function projectDeployRepo(pool: Q): ProjectDeployRepo {
    return {
        async findTarget(projectId, workspaceId) {
            const r = await pool.query<ProjectDeployTargetRow>(
                'SELECT * FROM project_deploy_targets WHERE project_id = ? AND workspace_id = ?',
                [projectId, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async upsertTarget({ projectId, workspaceId, credentialId, provider, externalId, content }) {
            await pool.query(
                `INSERT INTO project_deploy_targets
                     (project_id, workspace_id, credential_id, provider, external_id, content)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     credential_id = VALUES(credential_id),
                     provider = VALUES(provider),
                     external_id = VALUES(external_id),
                     content = VALUES(content)`,
                [projectId, workspaceId, credentialId, provider, externalId, content]
            );
            const r = await pool.query<ProjectDeployTargetRow>(
                'SELECT * FROM project_deploy_targets WHERE project_id = ?',
                [projectId]
            );
            return r.rows[0];
        },
        async deleteTarget(projectId, workspaceId) {
            // L'historique des déploiements **survit** au déliement : il dit ce
            // qui a réellement été poussé, et ça reste vrai même si la cible
            // change.
            const r = await pool.query('DELETE FROM project_deploy_targets WHERE project_id = ? AND workspace_id = ?', [
                projectId,
                workspaceId
            ]);
            return r.rowCount > 0;
        },

        async createDeployment({ projectId, workspaceId, provider, externalId, triggeredByUserId, content }) {
            const res = await pool.query(
                `INSERT INTO project_deployments
                     (project_id, workspace_id, provider, external_id, status, triggered_by_user_id, content)
                 VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
                [projectId, workspaceId, provider, externalId, triggeredByUserId, content]
            );
            const r = await pool.query<ProjectDeploymentRow>('SELECT * FROM project_deployments WHERE id = ?', [
                res.insertId
            ]);
            return r.rows[0];
        },
        async updateDeployment(id, { externalId, status, finishedAt, content }) {
            // Même garde atomique que `projectGit.markSynced`, et pour la même
            // raison : le suivi de fond chiffre à l'étage ouvert, et le projet
            // peut basculer en confidentiel entre la sélection et l'écriture.
            // Sans cette jointure, on déposerait un blob sous la mauvaise clé et
            // la conversion de tier suivante resterait bloquée pour de bon.
            await pool.query(
                `UPDATE project_deployments d
                 JOIN projects p ON p.id = d.project_id AND p.security_tier = 'open'
                 SET d.external_id = ?, d.status = ?, d.finished_at = ?, d.content = ?
                 WHERE d.id = ?`,
                [externalId, status, finishedAt, content, id]
            );
        },
        async listDeployments(projectId, workspaceId, limit) {
            const r = await pool.query<ProjectDeploymentRow>(
                `SELECT * FROM project_deployments WHERE project_id = ? AND workspace_id = ?
                 ORDER BY started_at DESC, id DESC LIMIT ?`,
                [projectId, workspaceId, limit]
            );
            return r.rows;
        },
        async listInFlight(limit) {
            const r = await pool.query<ProjectDeploymentRow>(
                `SELECT d.* FROM project_deployments d
                 JOIN projects p ON p.id = d.project_id
                 WHERE d.status IN ('queued', 'running')
                   AND p.security_tier = 'open'
                 ORDER BY d.started_at ASC
                 LIMIT ?`,
                [limit]
            );
            return r.rows;
        }
    };
}
