import type { ProjectUptimeLinkRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/**
 * Les services surveillés rattachés à un projet.
 *
 * On ne stocke que l'identifiant de la cible. Aucune donnée identifiante ici,
 * donc rien à chiffrer — et la cible garde ses propres droits : un membre sans
 * accès à Uptime verra qu'il y a des liaisons sans pouvoir les nommer, c'est la
 * feature visée qui tranche.
 *
 * Non exclusif dans les deux sens : un projet suit plusieurs services, un
 * service peut être suivi par plusieurs projets. Même forme que
 * `project_repo_links`, et pour la même raison — ce sont des objets d'espace,
 * pas des propriétés d'un projet.
 */
export interface ProjectLinksRepo {
    /** Les identifiants rattachés, dans l'ordre d'affichage d'Uptime. */
    listServiceIds(projectId: number, workspaceId: number): Promise<number[]>;
    link(projectId: number, workspaceId: number, serviceId: number): Promise<void>;
    unlink(projectId: number, workspaceId: number, serviceId: number): Promise<boolean>;
    /** Les lignes brutes d'un projet, pour les rares besoins qui les veulent. */
    listByProject(projectId: number, workspaceId: number): Promise<ProjectUptimeLinkRow[]>;
}

export function projectLinksRepo(pool: Q): ProjectLinksRepo {
    return {
        async listServiceIds(projectId, workspaceId) {
            // Trié comme la liste d'Uptime elle-même : les deux écrans montrent
            // les mêmes services, ils n'ont pas à les montrer dans deux ordres.
            const r = await pool.query<{ service_id: number }>(
                `SELECT l.service_id
                   FROM project_uptime_links l
                   JOIN uptime_services s ON s.id = l.service_id
                  WHERE l.project_id = ? AND l.workspace_id = ?
                  ORDER BY s.sort_order ASC, s.id ASC`,
                [projectId, workspaceId]
            );
            return r.rows.map((row) => Number(row.service_id));
        },
        async listByProject(projectId, workspaceId) {
            const r = await pool.query<ProjectUptimeLinkRow>(
                'SELECT * FROM project_uptime_links WHERE project_id = ? AND workspace_id = ?',
                [projectId, workspaceId]
            );
            return r.rows;
        },
        async link(projectId, workspaceId, serviceId) {
            // La paire (projet, service) est la clé primaire : reposer la même
            // liaison n'est pas une erreur, c'est le même fait déclaré deux fois.
            await pool.query(
                'INSERT IGNORE INTO project_uptime_links (project_id, service_id, workspace_id) VALUES (?, ?, ?)',
                [projectId, serviceId, workspaceId]
            );
        },
        async unlink(projectId, workspaceId, serviceId) {
            const r = await pool.query(
                'DELETE FROM project_uptime_links WHERE project_id = ? AND service_id = ? AND workspace_id = ?',
                [projectId, serviceId, workspaceId]
            );
            return r.rowCount > 0;
        }
    };
}
