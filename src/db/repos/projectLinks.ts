import type {
    ProjectAudienceLinkRow,
    ProjectDatabaseLinkRow,
    ProjectDeployLinkRow,
    ProjectRepoLinkRow,
    ProjectStatus,
    ProjectUptimeLinkRow
} from '@deveye/types';
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
 * (`project_uptime_links`), les bases de données (`project_database_links`),
 * les cibles de déploiement (`project_deploy_links`), les dépôts git
 * (`project_repo_links`) et les sites suivis (`project_audience_links`).
 *
 * On ne stocke que l'identifiant de la cible. Aucune donnée identifiante ici,
 * donc rien à chiffrer — et la cible garde ses propres droits : un membre sans
 * accès à Uptime verra qu'il y a des liaisons sans pouvoir les nommer, c'est la
 * feature visée qui tranche.
 *
 * Non exclusif dans les deux sens : un projet suit plusieurs services, un
 * service peut être suivi par plusieurs projets. Même forme que
 * `project_repo_links`, la première de la famille, et pour la même raison — ce
 * sont des objets d'espace, pas des propriétés d'un projet.
 *
 * Les cinq tables sont celles de Projets, pas des modules visés : Uptime,
 * Bases de données, Déploiement, Git et Audience ne lisent aucune table de
 * Projets, et Projets ne lit les leurs que pour l'ordre d'affichage (une
 * jointure admise).
 * Ce que le module a besoin de savoir des projets (combien relient chaque
 * élément, lesquels, sous quel titre) lui est offert par le contrat
 * `PROJECTS_USAGE_PROVIDER`, lu ici.
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

    // -- liaison projet → cible de déploiement ----------------------------
    /** Les identifiants rattachés, dans l'ordre d'affichage de Déploiement. */
    listDeployTargetIds(projectId: number, workspaceId: number): Promise<number[]>;
    linkDeployTarget(projectId: number, workspaceId: number, targetId: number): Promise<void>;
    unlinkDeployTarget(projectId: number, workspaceId: number, targetId: number): Promise<boolean>;
    /** Retire toutes les liaisons d'un projet : sa conversion en confidentiel. Rend le nombre retiré. */
    unlinkAllDeployTargets(projectId: number, workspaceId: number): Promise<number>;
    /** Les projets qui déploient cette cible — le titre reste à déchiffrer. */
    listDeployUsage(targetId: number, workspaceId: number): Promise<ProjectUsageRow[]>;
    /** Combien de projets de l'espace relient chaque cible (absente = zéro). */
    countDeployLinks(workspaceId: number): Promise<Map<number, number>>;

    // -- liaison projet → dépôt git ---------------------------------------
    /** Les dépôts liés à un projet, dans l'ordre de la liste de la feature Git. */
    listRepoIds(projectId: number, workspaceId: number): Promise<number[]>;
    linkRepo(projectId: number, workspaceId: number, repoId: number): Promise<void>;
    unlinkRepo(projectId: number, workspaceId: number, repoId: number): Promise<boolean>;
    /** Retire toutes les liaisons d'un projet (passage en confidentiel). Rend le nombre retiré. */
    unlinkAllRepos(projectId: number, workspaceId: number): Promise<number>;
    /** Les projets qui utilisent ce dépôt — le titre reste à déchiffrer. */
    listRepoUsage(repoId: number, workspaceId: number): Promise<ProjectUsageRow[]>;
    /** Combien de projets de l'espace relient chaque dépôt (absent = zéro). */
    countRepoLinks(workspaceId: number): Promise<Map<number, number>>;

    // -- liaison projet → site suivi --------------------------------------
    /** Les sites liés à un projet, dans l'ordre de la liste de la feature Audience. */
    listSiteIds(projectId: number, workspaceId: number): Promise<number[]>;
    linkSite(projectId: number, workspaceId: number, siteId: number): Promise<void>;
    unlinkSite(projectId: number, workspaceId: number, siteId: number): Promise<boolean>;
    /** Retire toutes les liaisons d'un projet (passage en confidentiel). */
    unlinkAllSites(projectId: number, workspaceId: number): Promise<void>;
    /** Les projets qui suivent ce site — le titre reste à déchiffrer. */
    listSiteUsage(siteId: number, workspaceId: number): Promise<ProjectUsageRow[]>;
    /** Combien de projets de l'espace relient chaque site (absent = zéro). */
    countSiteLinks(workspaceId: number): Promise<Map<number, number>>;
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
        },

        async listDeployTargetIds(projectId, workspaceId) {
            // Trié comme la liste de la feature : les deux écrans montrent les
            // mêmes cibles, ils n'ont pas à les montrer dans deux ordres.
            const r = await pool.query<{ target_id: number }>(
                `SELECT l.target_id
                   FROM project_deploy_links l
                   JOIN deploy_targets t ON t.id = l.target_id
                  WHERE l.project_id = ? AND l.workspace_id = ?
                  ORDER BY t.sort_order ASC, t.id ASC`,
                [projectId, workspaceId]
            );
            return r.rows.map((row) => Number(row.target_id));
        },
        async linkDeployTarget(projectId, workspaceId, targetId) {
            // La paire est la clé primaire : reposer la même liaison n'est pas
            // une erreur, c'est le même fait déclaré deux fois.
            await pool.query(
                'INSERT IGNORE INTO project_deploy_links (project_id, target_id, workspace_id) VALUES (?, ?, ?)',
                [projectId, targetId, workspaceId]
            );
        },
        async unlinkDeployTarget(projectId, workspaceId, targetId) {
            const r = await pool.query(
                'DELETE FROM project_deploy_links WHERE project_id = ? AND target_id = ? AND workspace_id = ?',
                [projectId, targetId, workspaceId]
            );
            return r.rowCount > 0;
        },
        async unlinkAllDeployTargets(projectId, workspaceId) {
            const r = await pool.query('DELETE FROM project_deploy_links WHERE project_id = ? AND workspace_id = ?', [
                projectId,
                workspaceId
            ]);
            return r.rowCount;
        },
        async listDeployUsage(targetId, workspaceId) {
            // Même règle que les bases : l'étage ouvert seul, donc des titres
            // lisibles sans session (un projet confidentiel ne se relie pas).
            const r = await pool.query<ProjectUsageRow>(
                `SELECT p.id AS project_id, p.status, p.content
                   FROM project_deploy_links l
                   JOIN projects p ON p.id = l.project_id
                  WHERE l.target_id = ? AND l.workspace_id = ? AND p.security_tier = 'open'
                  ORDER BY p.sort_order ASC, p.id ASC`,
                [targetId, workspaceId]
            );
            return r.rows;
        },
        async countDeployLinks(workspaceId) {
            // « Combien de projets déploient cette cible » se lit sur l'index de
            // la table de liaison seul (migration 080) : une requête pour tout
            // l'espace, ce que la liste des cibles demande en une fois.
            const r = await pool.query<Pick<ProjectDeployLinkRow, 'target_id'> & { n: number }>(
                `SELECT l.target_id, COUNT(*) AS n
                   FROM project_deploy_links l
                  WHERE l.workspace_id = ?
                  GROUP BY l.target_id`,
                [workspaceId]
            );
            return new Map(r.rows.map((row) => [Number(row.target_id), Number(row.n)]));
        },

        async listRepoIds(projectId, workspaceId) {
            // Trié comme la liste de la feature Git elle-même : les deux écrans
            // montrent les mêmes dépôts, ils n'ont pas à les montrer dans deux
            // ordres. La jointure sur `git_repos` est admise, pour l'ordre seul.
            const r = await pool.query<{ repo_id: number }>(
                `SELECT l.repo_id
                   FROM project_repo_links l
                   JOIN git_repos g ON g.id = l.repo_id
                  WHERE l.project_id = ? AND l.workspace_id = ?
                  ORDER BY g.sort_order ASC, g.id ASC`,
                [projectId, workspaceId]
            );
            return r.rows.map((row) => Number(row.repo_id));
        },
        async linkRepo(projectId, workspaceId, repoId) {
            // Le couple (projet, dépôt) est la clé primaire depuis la migration
            // 069 : relier deux fois le même dépôt n'est pas une erreur, c'est
            // le même fait déclaré deux fois.
            await pool.query(
                'INSERT IGNORE INTO project_repo_links (project_id, workspace_id, repo_id) VALUES (?, ?, ?)',
                [projectId, workspaceId, repoId]
            );
        },
        async unlinkRepo(projectId, workspaceId, repoId) {
            const r = await pool.query(
                'DELETE FROM project_repo_links WHERE project_id = ? AND repo_id = ? AND workspace_id = ?',
                [projectId, repoId, workspaceId]
            );
            return r.rowCount > 0;
        },
        async unlinkAllRepos(projectId, workspaceId) {
            const r = await pool.query('DELETE FROM project_repo_links WHERE project_id = ? AND workspace_id = ?', [
                projectId,
                workspaceId
            ]);
            return r.rowCount;
        },
        async listRepoUsage(repoId, workspaceId) {
            // Les projets confidentiels ne peuvent pas être liés : filtrer sur
            // l'étage ouvert garantit que tous les titres rendus ici sont
            // lisibles sans session, plutôt que d'en masquer certains.
            const r = await pool.query<ProjectUsageRow>(
                `SELECT p.id AS project_id, p.status, p.content
                   FROM project_repo_links l
                   JOIN projects p ON p.id = l.project_id
                  WHERE l.repo_id = ? AND l.workspace_id = ? AND p.security_tier = 'open'
                  ORDER BY p.sort_order ASC, p.id ASC`,
                [repoId, workspaceId]
            );
            return r.rows;
        },
        async countRepoLinks(workspaceId) {
            // « Combien de projets utilisent ce dépôt » se lit sur l'index de la
            // table de liaison seul (`idx_project_repo_links_repo`, migration
            // 064) : une requête pour tout l'espace, ce que la liste des dépôts
            // demande en une fois.
            const r = await pool.query<Pick<ProjectRepoLinkRow, 'repo_id'> & { n: number }>(
                `SELECT l.repo_id, COUNT(*) AS n
                   FROM project_repo_links l
                  WHERE l.workspace_id = ?
                  GROUP BY l.repo_id`,
                [workspaceId]
            );
            return new Map(r.rows.map((row) => [Number(row.repo_id), Number(row.n)]));
        },

        async listSiteIds(projectId, workspaceId) {
            // Trié comme la liste de la feature Audience elle-même : les deux
            // écrans montrent les mêmes sites, ils n'ont pas à les montrer dans
            // deux ordres. La jointure sur `audience_sites` est admise, pour
            // l'ordre seul.
            const r = await pool.query<{ site_id: number }>(
                `SELECT l.site_id
                   FROM project_audience_links l
                   JOIN audience_sites s ON s.id = l.site_id
                  WHERE l.project_id = ? AND l.workspace_id = ?
                  ORDER BY s.sort_order ASC, s.id ASC`,
                [projectId, workspaceId]
            );
            return r.rows.map((row) => Number(row.site_id));
        },
        async linkSite(projectId, workspaceId, siteId) {
            // Idempotente : relier deux fois le même site ne crée pas un doublon.
            await pool.query(
                `INSERT INTO project_audience_links (project_id, site_id, workspace_id)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE workspace_id = VALUES(workspace_id)`,
                [projectId, siteId, workspaceId]
            );
        },
        async unlinkSite(projectId, workspaceId, siteId) {
            const r = await pool.query(
                'DELETE FROM project_audience_links WHERE project_id = ? AND workspace_id = ? AND site_id = ?',
                [projectId, workspaceId, siteId]
            );
            return r.rowCount > 0;
        },
        async unlinkAllSites(projectId, workspaceId) {
            await pool.query('DELETE FROM project_audience_links WHERE project_id = ? AND workspace_id = ?', [
                projectId,
                workspaceId
            ]);
        },
        async listSiteUsage(siteId, workspaceId) {
            // Même règle que les bases : l'étage ouvert seul, donc des titres
            // lisibles sans session (un projet confidentiel ne se relie pas).
            // Et les archivés à part, comme la native le faisait : un projet
            // rangé ne suit plus rien à l'écran.
            const r = await pool.query<ProjectUsageRow>(
                `SELECT p.id AS project_id, p.status, p.content
                   FROM project_audience_links l
                   JOIN projects p ON p.id = l.project_id
                  WHERE l.site_id = ? AND l.workspace_id = ? AND p.security_tier = 'open'
                    AND p.archived_at IS NULL
                  ORDER BY p.sort_order ASC, p.id ASC`,
                [siteId, workspaceId]
            );
            return r.rows;
        },
        async countSiteLinks(workspaceId) {
            // « Combien de projets suivent ce site » se lit sur l'index de la
            // table de liaison seul (migration 077) : une requête pour tout
            // l'espace, ce que la liste des sites demande en une fois.
            const r = await pool.query<Pick<ProjectAudienceLinkRow, 'site_id'> & { n: number }>(
                `SELECT l.site_id, COUNT(*) AS n
                   FROM project_audience_links l
                  WHERE l.workspace_id = ?
                  GROUP BY l.site_id`,
                [workspaceId]
            );
            return new Map(r.rows.map((row) => [Number(row.site_id), Number(row.n)]));
        }
    };
}
