import type { ProjectDatabaseLinkRow, ProjectStatus, ProjectUptimeLinkRow } from '@deveye/types';
import type { Queryable } from '../pool';

type Q = Queryable;

/** Un projet lié à un élément d'espace, tel que la jointure le rend. */
export interface ProjectUsageRow {
    project_id: number;
    status: ProjectStatus;
    /** Le corps chiffré du projet ; le titre reste à déchiffrer. */
    content: string;
}

/**
 * Les objets d'espace rattachés à un projet : les services surveillés
 * (`project_uptime_links`) et les bases de données (`project_database_links`).
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
 *
 * Les deux tables sont celles de Projets, pas des modules visés : Uptime et
 * Bases de données ne lisent aucune table de Projets, et Projets ne lit les
 * leurs que pour l'ordre d'affichage (une jointure admise, comme pour un
 * dépôt git). Ce que le module a besoin de savoir des projets (combien
 * relient chaque élément, lesquels, sous quel titre) lui est offert par le
 * contrat `PROJECTS_USAGE_PROVIDER`, lu ici.
 */
export interface ProjectLinksRepo {
    /** Les identifiants rattachés, dans l'ordre d'affichage d'Uptime. */
    listServiceIds(projectId: number, workspaceId: number): Promise<number[]>;
    link(projectId: number, workspaceId: number, serviceId: number): Promise<void>;
    unlink(projectId: number, workspaceId: number, serviceId: number): Promise<boolean>;
    /** Les lignes brutes d'un projet, pour les rares besoins qui les veulent. */
    listByProject(projectId: number, workspaceId: number): Promise<ProjectUptimeLinkRow[]>;

    // -- liaison projet → base --------------------------------------------
    /** Les identifiants rattachés, dans l'ordre d'affichage de Bases de données. */
    listDatabaseIds(projectId: number, workspaceId: number): Promise<number[]>;
    linkDatabase(projectId: number, workspaceId: number, databaseId: number): Promise<void>;
    unlinkDatabase(projectId: number, workspaceId: number, databaseId: number): Promise<boolean>;
    unlinkAllDatabases(projectId: number, workspaceId: number): Promise<void>;
    /** Les projets qui utilisent cette base — le titre reste à déchiffrer. */
    listDatabaseUsage(databaseId: number, workspaceId: number): Promise<ProjectUsageRow[]>;
    /** Combien de projets de l'espace relient chaque base (absente = zéro). */
    countDatabaseLinks(workspaceId: number): Promise<Map<number, number>>;
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
        },

        async listDatabaseIds(projectId, workspaceId) {
            // Trié comme la liste de Bases de données elle-même, pour la même
            // raison que les services : deux écrans, un seul ordre.
            const r = await pool.query<{ database_id: number }>(
                `SELECT l.database_id
                   FROM project_database_links l
                   JOIN database_connections d ON d.id = l.database_id
                  WHERE l.project_id = ? AND l.workspace_id = ?
                  ORDER BY d.sort_order ASC, d.id ASC`,
                [projectId, workspaceId]
            );
            return r.rows.map((row) => Number(row.database_id));
        },
        async linkDatabase(projectId, workspaceId, databaseId) {
            await pool.query(
                'INSERT IGNORE INTO project_database_links (project_id, database_id, workspace_id) VALUES (?, ?, ?)',
                [projectId, databaseId, workspaceId]
            );
        },
        async unlinkDatabase(projectId, workspaceId, databaseId) {
            const r = await pool.query(
                'DELETE FROM project_database_links WHERE project_id = ? AND database_id = ? AND workspace_id = ?',
                [projectId, databaseId, workspaceId]
            );
            return r.rowCount > 0;
        },
        async unlinkAllDatabases(projectId, workspaceId) {
            await pool.query('DELETE FROM project_database_links WHERE project_id = ? AND workspace_id = ?', [
                projectId,
                workspaceId
            ]);
        },
        async listDatabaseUsage(databaseId, workspaceId) {
            // Les projets confidentiels ne peuvent pas être liés : filtrer sur
            // l'étage ouvert garantit que tous les titres rendus ici sont
            // lisibles sans session, plutôt que d'en masquer certains.
            const r = await pool.query<ProjectUsageRow>(
                `SELECT p.id AS project_id, p.status, p.content
                   FROM project_database_links l
                   JOIN projects p ON p.id = l.project_id
                  WHERE l.database_id = ? AND l.workspace_id = ? AND p.security_tier = 'open'
                  ORDER BY p.sort_order ASC, p.id ASC`,
                [databaseId, workspaceId]
            );
            return r.rows;
        },
        async countDatabaseLinks(workspaceId) {
            // « Combien de projets utilisent cette base » se lit sur l'index de
            // la table de liaison seul (migration 068) : une requête pour tout
            // l'espace, ce que la liste des bases demande en une fois.
            const r = await pool.query<Pick<ProjectDatabaseLinkRow, 'database_id'> & { n: number }>(
                `SELECT l.database_id, COUNT(*) AS n
                   FROM project_database_links l
                  WHERE l.workspace_id = ?
                  GROUP BY l.database_id`,
                [workspaceId]
            );
            return new Map(r.rows.map((row) => [Number(row.database_id), Number(row.n)]));
        }
    };
}
