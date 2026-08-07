import type { ProjectLinkRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/**
 * Les liens d'un projet vers le reste de DevEye.
 *
 * On ne stocke que le type et l'identifiant de la cible. Aucune donnée
 * identifiante ici, donc rien à chiffrer — et la cible garde ses propres
 * droits : un membre sans accès à Uptime verra le lien sans pouvoir l'ouvrir,
 * c'est la feature visée qui tranche.
 */
export interface ProjectLinksRepo {
    listByProject(projectId: number, workspaceId: number): Promise<ProjectLinkRow[]>;
    findById(linkId: number, workspaceId: number): Promise<ProjectLinkRow | null>;
    create(input: { projectId: number; workspaceId: number; kind: string; targetId: string }): Promise<ProjectLinkRow>;
    delete(linkId: number, workspaceId: number): Promise<boolean>;
}

export function projectLinksRepo(pool: Q): ProjectLinksRepo {
    return {
        async listByProject(projectId, workspaceId) {
            const r = await pool.query<ProjectLinkRow>(
                'SELECT * FROM project_links WHERE project_id = ? AND workspace_id = ? ORDER BY kind ASC, id ASC',
                [projectId, workspaceId]
            );
            return r.rows;
        },
        async findById(linkId, workspaceId) {
            const r = await pool.query<ProjectLinkRow>(
                'SELECT * FROM project_links WHERE id = ? AND workspace_id = ?',
                [linkId, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async create({ projectId, workspaceId, kind, targetId }) {
            // La paire (projet, type, cible) est unique : reposer le même lien
            // n'est pas une erreur, c'est le même fait déclaré deux fois.
            await pool.query(
                'INSERT IGNORE INTO project_links (project_id, workspace_id, kind, target_id) VALUES (?, ?, ?, ?)',
                [projectId, workspaceId, kind, targetId]
            );
            const r = await pool.query<ProjectLinkRow>(
                'SELECT * FROM project_links WHERE project_id = ? AND kind = ? AND target_id = ?',
                [projectId, kind, targetId]
            );
            return r.rows[0];
        },
        async delete(linkId, workspaceId) {
            const r = await pool.query('DELETE FROM project_links WHERE id = ? AND workspace_id = ?', [
                linkId,
                workspaceId
            ]);
            return r.rowCount > 0;
        }
    };
}
