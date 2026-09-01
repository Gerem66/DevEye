import type {
    ProjectAudienceLinkRow,
    ProjectDatabaseLinkRow,
    ProjectDeployLinkRow,
    ProjectRepoLinkRow,
    ProjectUptimeLinkRow
} from '../../contracts/domain';
import type { ProjectStatus } from '@deveye/types';
import type { SdkQueryable } from '@deveye/types/sdk/server';

/** Un projet lié à un élément d'espace, tel que la jointure le rend. */
export interface ProjectUsageRow {
    project_id: number;
    status: ProjectStatus;
    /** Le corps chiffré du projet ; le titre reste à déchiffrer. */
    content: string;
}

/**
 * Les objets d'espace rattachés à un projet : services surveillés, bases de données,
 * cibles de déploiement, dépôts git et sites suivis. Seul l'identifiant de la cible
 * est stocké, rien d'identifiant donc rien à chiffrer, et la cible garde ses propres
 * droits : c'est la feature visée qui tranche. Non exclusif dans les deux sens, ce
 * sont des objets d'espace et non des propriétés d'un projet.
 *
 * Les cinq tables sont celles de Projets, pas des modules visés : ceux-ci n'en
 * lisent aucune, Projets ne lit les leurs que pour l'ordre d'affichage, et ce qu'ils
 * ont besoin de savoir des projets leur est offert par `PROJECTS_USAGE_PROVIDER`.
 *
 * Une même forme pour les cinq familles : `list*Ids` rend les identifiants dans
 * l'ordre d'affichage de la feature visée, `list*Usage` les projets qui relient un
 * élément (titre encore chiffré), `count*Links` une entrée par élément relié de
 * l'espace, un élément absent valant zéro, `unlinkAll*` sert la conversion d'un
 * projet en confidentiel, et `detach*` le départ d'un élément vers un autre espace :
 * une liaison ne traverse pas une frontière d'espace, elle est retirée.
 */
export interface ProjectLinksRepo {
    listServiceIds(projectId: number, workspaceId: number): Promise<number[]>;
    link(projectId: number, workspaceId: number, serviceId: number): Promise<void>;
    unlink(projectId: number, workspaceId: number, serviceId: number): Promise<boolean>;
    /** Les lignes brutes, pour les rares appelants qui les veulent. */
    listByProject(projectId: number, workspaceId: number): Promise<ProjectUptimeLinkRow[]>;
    listServiceUsage(serviceId: number, workspaceId: number): Promise<ProjectUsageRow[]>;
    countServiceLinks(workspaceId: number): Promise<Map<number, number>>;
    detachService(serviceId: number, workspaceId: number): Promise<number>;

    // -- liaison projet → base --------------------------------------------
    listDatabaseIds(projectId: number, workspaceId: number): Promise<number[]>;
    linkDatabase(projectId: number, workspaceId: number, databaseId: number): Promise<void>;
    unlinkDatabase(projectId: number, workspaceId: number, databaseId: number): Promise<boolean>;
    unlinkAllDatabases(projectId: number, workspaceId: number): Promise<void>;
    detachDatabase(databaseId: number, workspaceId: number): Promise<number>;
    listDatabaseUsage(databaseId: number, workspaceId: number): Promise<ProjectUsageRow[]>;
    countDatabaseLinks(workspaceId: number): Promise<Map<number, number>>;

    // -- liaison projet → cible de déploiement ----------------------------
    listDeployTargetIds(projectId: number, workspaceId: number): Promise<number[]>;
    linkDeployTarget(projectId: number, workspaceId: number, targetId: number): Promise<void>;
    unlinkDeployTarget(projectId: number, workspaceId: number, targetId: number): Promise<boolean>;
    unlinkAllDeployTargets(projectId: number, workspaceId: number): Promise<number>;
    detachDeployTarget(targetId: number, workspaceId: number): Promise<number>;
    listDeployUsage(targetId: number, workspaceId: number): Promise<ProjectUsageRow[]>;
    countDeployLinks(workspaceId: number): Promise<Map<number, number>>;

    // -- liaison projet → dépôt git ---------------------------------------
    listRepoIds(projectId: number, workspaceId: number): Promise<number[]>;
    linkRepo(projectId: number, workspaceId: number, repoId: number): Promise<void>;
    unlinkRepo(projectId: number, workspaceId: number, repoId: number): Promise<boolean>;
    unlinkAllRepos(projectId: number, workspaceId: number): Promise<number>;
    detachRepo(repoId: number, workspaceId: number): Promise<number>;
    listRepoUsage(repoId: number, workspaceId: number): Promise<ProjectUsageRow[]>;
    countRepoLinks(workspaceId: number): Promise<Map<number, number>>;

    // -- liaison projet → site suivi --------------------------------------
    listSiteIds(projectId: number, workspaceId: number): Promise<number[]>;
    linkSite(projectId: number, workspaceId: number, siteId: number): Promise<void>;
    unlinkSite(projectId: number, workspaceId: number, siteId: number): Promise<boolean>;
    unlinkAllSites(projectId: number, workspaceId: number): Promise<void>;
    detachSite(siteId: number, workspaceId: number): Promise<number>;
    listSiteUsage(siteId: number, workspaceId: number): Promise<ProjectUsageRow[]>;
    countSiteLinks(workspaceId: number): Promise<Map<number, number>>;
}

export function projectLinksRepo(q: SdkQueryable): ProjectLinksRepo {
    return {
        async listServiceIds(projectId, workspaceId) {
            // Trié comme la liste d'Uptime : deux écrans, un seul ordre.
            const rows = await q.query<{ service_id: number }>(
                `SELECT l.service_id
                   FROM project_uptime_links l
                   JOIN uptime_services s ON s.id = l.service_id
                  WHERE l.project_id = ? AND l.workspace_id = ?
                  ORDER BY s.sort_order ASC, s.id ASC`,
                [projectId, workspaceId]
            );
            return rows.map((row) => Number(row.service_id));
        },
        async listByProject(projectId, workspaceId) {
            return q.query<ProjectUptimeLinkRow>(
                'SELECT * FROM project_uptime_links WHERE project_id = ? AND workspace_id = ?',
                [projectId, workspaceId]
            );
        },
        async listServiceUsage(serviceId, workspaceId) {
            // L'étage ouvert seul, comme les quatre autres familles.
            return q.query<ProjectUsageRow>(
                `SELECT p.id AS project_id, p.status, p.content
                   FROM project_uptime_links l
                   JOIN projects p ON p.id = l.project_id
                  WHERE l.service_id = ? AND l.workspace_id = ? AND p.security_tier = 'open'
                  ORDER BY p.sort_order ASC, p.id ASC`,
                [serviceId, workspaceId]
            );
        },
        async countServiceLinks(workspaceId) {
            const rows = await q.query<Pick<ProjectUptimeLinkRow, 'service_id'> & { n: number }>(
                `SELECT l.service_id, COUNT(*) AS n
                   FROM project_uptime_links l
                  WHERE l.workspace_id = ?
                  GROUP BY l.service_id`,
                [workspaceId]
            );
            return new Map(rows.map((row) => [Number(row.service_id), Number(row.n)]));
        },
        async detachService(serviceId, workspaceId) {
            const res = await q.execute('DELETE FROM project_uptime_links WHERE service_id = ? AND workspace_id = ?', [
                serviceId,
                workspaceId
            ]);
            return res.affectedRows;
        },
        async link(projectId, workspaceId, serviceId) {
            // La paire est la clé primaire : reposer la même liaison n'est pas une
            // erreur mais le même fait déclaré deux fois.
            await q.execute(
                'INSERT IGNORE INTO project_uptime_links (project_id, service_id, workspace_id) VALUES (?, ?, ?)',
                [projectId, serviceId, workspaceId]
            );
        },
        async unlink(projectId, workspaceId, serviceId) {
            const res = await q.execute(
                'DELETE FROM project_uptime_links WHERE project_id = ? AND service_id = ? AND workspace_id = ?',
                [projectId, serviceId, workspaceId]
            );
            return res.affectedRows > 0;
        },

        async listDatabaseIds(projectId, workspaceId) {
            // Trié comme la liste de Bases de données : deux écrans, un seul ordre.
            const rows = await q.query<{ database_id: number }>(
                `SELECT l.database_id
                   FROM project_database_links l
                   JOIN database_connections d ON d.id = l.database_id
                  WHERE l.project_id = ? AND l.workspace_id = ?
                  ORDER BY d.sort_order ASC, d.id ASC`,
                [projectId, workspaceId]
            );
            return rows.map((row) => Number(row.database_id));
        },
        async linkDatabase(projectId, workspaceId, databaseId) {
            await q.execute(
                'INSERT IGNORE INTO project_database_links (project_id, database_id, workspace_id) VALUES (?, ?, ?)',
                [projectId, databaseId, workspaceId]
            );
        },
        async unlinkDatabase(projectId, workspaceId, databaseId) {
            const res = await q.execute(
                'DELETE FROM project_database_links WHERE project_id = ? AND database_id = ? AND workspace_id = ?',
                [projectId, databaseId, workspaceId]
            );
            return res.affectedRows > 0;
        },
        async unlinkAllDatabases(projectId, workspaceId) {
            await q.execute('DELETE FROM project_database_links WHERE project_id = ? AND workspace_id = ?', [
                projectId,
                workspaceId
            ]);
        },
        async listDatabaseUsage(databaseId, workspaceId) {
            // L'étage ouvert seul : un projet confidentiel ne se reliant pas, tous
            // les titres rendus ici sont lisibles sans session.
            return q.query<ProjectUsageRow>(
                `SELECT p.id AS project_id, p.status, p.content
                   FROM project_database_links l
                   JOIN projects p ON p.id = l.project_id
                  WHERE l.database_id = ? AND l.workspace_id = ? AND p.security_tier = 'open'
                  ORDER BY p.sort_order ASC, p.id ASC`,
                [databaseId, workspaceId]
            );
        },
        async detachDatabase(itemId, workspaceId) {
            const res = await q.execute(
                'DELETE FROM project_database_links WHERE database_id = ? AND workspace_id = ?',
                [itemId, workspaceId]
            );
            return res.affectedRows;
        },
        async countDatabaseLinks(workspaceId) {
            // L'index de la table de liaison suffit : une requête pour tout l'espace,
            // ce que la liste des bases demande en une fois.
            const rows = await q.query<Pick<ProjectDatabaseLinkRow, 'database_id'> & { n: number }>(
                `SELECT l.database_id, COUNT(*) AS n
                   FROM project_database_links l
                  WHERE l.workspace_id = ?
                  GROUP BY l.database_id`,
                [workspaceId]
            );
            return new Map(rows.map((row) => [Number(row.database_id), Number(row.n)]));
        },

        async listDeployTargetIds(projectId, workspaceId) {
            // Trié comme la liste de Déploiement : deux écrans, un seul ordre.
            const rows = await q.query<{ target_id: number }>(
                `SELECT l.target_id
                   FROM project_deploy_links l
                   JOIN deploy_targets t ON t.id = l.target_id
                  WHERE l.project_id = ? AND l.workspace_id = ?
                  ORDER BY t.sort_order ASC, t.id ASC`,
                [projectId, workspaceId]
            );
            return rows.map((row) => Number(row.target_id));
        },
        async linkDeployTarget(projectId, workspaceId, targetId) {
            // La paire est la clé primaire : reposer la même liaison n'est pas
            // une erreur, c'est le même fait déclaré deux fois.
            await q.execute(
                'INSERT IGNORE INTO project_deploy_links (project_id, target_id, workspace_id) VALUES (?, ?, ?)',
                [projectId, targetId, workspaceId]
            );
        },
        async unlinkDeployTarget(projectId, workspaceId, targetId) {
            const res = await q.execute(
                'DELETE FROM project_deploy_links WHERE project_id = ? AND target_id = ? AND workspace_id = ?',
                [projectId, targetId, workspaceId]
            );
            return res.affectedRows > 0;
        },
        async unlinkAllDeployTargets(projectId, workspaceId) {
            const res = await q.execute('DELETE FROM project_deploy_links WHERE project_id = ? AND workspace_id = ?', [
                projectId,
                workspaceId
            ]);
            return res.affectedRows;
        },
        async listDeployUsage(targetId, workspaceId) {
            // L'étage ouvert seul, comme pour les bases.
            return q.query<ProjectUsageRow>(
                `SELECT p.id AS project_id, p.status, p.content
                   FROM project_deploy_links l
                   JOIN projects p ON p.id = l.project_id
                  WHERE l.target_id = ? AND l.workspace_id = ? AND p.security_tier = 'open'
                  ORDER BY p.sort_order ASC, p.id ASC`,
                [targetId, workspaceId]
            );
        },
        async detachDeployTarget(itemId, workspaceId) {
            const res = await q.execute('DELETE FROM project_deploy_links WHERE target_id = ? AND workspace_id = ?', [
                itemId,
                workspaceId
            ]);
            return res.affectedRows;
        },
        async countDeployLinks(workspaceId) {
            // L'index de la table de liaison suffit, une requête pour tout l'espace.
            const rows = await q.query<Pick<ProjectDeployLinkRow, 'target_id'> & { n: number }>(
                `SELECT l.target_id, COUNT(*) AS n
                   FROM project_deploy_links l
                  WHERE l.workspace_id = ?
                  GROUP BY l.target_id`,
                [workspaceId]
            );
            return new Map(rows.map((row) => [Number(row.target_id), Number(row.n)]));
        },

        async listRepoIds(projectId, workspaceId) {
            // Trié comme la liste de la feature Git : deux écrans, un seul ordre. La
            // jointure sur `git_repos` est admise, pour l'ordre seul.
            const rows = await q.query<{ repo_id: number }>(
                `SELECT l.repo_id
                   FROM project_repo_links l
                   JOIN git_repos g ON g.id = l.repo_id
                  WHERE l.project_id = ? AND l.workspace_id = ?
                  ORDER BY g.sort_order ASC, g.id ASC`,
                [projectId, workspaceId]
            );
            return rows.map((row) => Number(row.repo_id));
        },
        async linkRepo(projectId, workspaceId, repoId) {
            // Le couple est la clé primaire : relier deux fois le même dépôt n'est
            // pas une erreur mais le même fait déclaré deux fois.
            await q.execute(
                'INSERT IGNORE INTO project_repo_links (project_id, workspace_id, repo_id) VALUES (?, ?, ?)',
                [projectId, workspaceId, repoId]
            );
        },
        async unlinkRepo(projectId, workspaceId, repoId) {
            const res = await q.execute(
                'DELETE FROM project_repo_links WHERE project_id = ? AND repo_id = ? AND workspace_id = ?',
                [projectId, repoId, workspaceId]
            );
            return res.affectedRows > 0;
        },
        async unlinkAllRepos(projectId, workspaceId) {
            const res = await q.execute('DELETE FROM project_repo_links WHERE project_id = ? AND workspace_id = ?', [
                projectId,
                workspaceId
            ]);
            return res.affectedRows;
        },
        async listRepoUsage(repoId, workspaceId) {
            // L'étage ouvert seul, comme pour les bases.
            return q.query<ProjectUsageRow>(
                `SELECT p.id AS project_id, p.status, p.content
                   FROM project_repo_links l
                   JOIN projects p ON p.id = l.project_id
                  WHERE l.repo_id = ? AND l.workspace_id = ? AND p.security_tier = 'open'
                  ORDER BY p.sort_order ASC, p.id ASC`,
                [repoId, workspaceId]
            );
        },
        async detachRepo(itemId, workspaceId) {
            const res = await q.execute('DELETE FROM project_repo_links WHERE repo_id = ? AND workspace_id = ?', [
                itemId,
                workspaceId
            ]);
            return res.affectedRows;
        },
        async countRepoLinks(workspaceId) {
            // L'index de la table de liaison suffit, une requête pour tout l'espace.
            const rows = await q.query<Pick<ProjectRepoLinkRow, 'repo_id'> & { n: number }>(
                `SELECT l.repo_id, COUNT(*) AS n
                   FROM project_repo_links l
                  WHERE l.workspace_id = ?
                  GROUP BY l.repo_id`,
                [workspaceId]
            );
            return new Map(rows.map((row) => [Number(row.repo_id), Number(row.n)]));
        },

        async listSiteIds(projectId, workspaceId) {
            // Trié comme la liste de la feature Audience : deux écrans, un seul
            // ordre. La jointure sur `audience_sites` est admise, pour l'ordre seul.
            const rows = await q.query<{ site_id: number }>(
                `SELECT l.site_id
                   FROM project_audience_links l
                   JOIN audience_sites s ON s.id = l.site_id
                  WHERE l.project_id = ? AND l.workspace_id = ?
                  ORDER BY s.sort_order ASC, s.id ASC`,
                [projectId, workspaceId]
            );
            return rows.map((row) => Number(row.site_id));
        },
        async linkSite(projectId, workspaceId, siteId) {
            // Idempotente : relier deux fois le même site ne crée pas un doublon.
            await q.execute(
                `INSERT INTO project_audience_links (project_id, site_id, workspace_id)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE workspace_id = VALUES(workspace_id)`,
                [projectId, siteId, workspaceId]
            );
        },
        async unlinkSite(projectId, workspaceId, siteId) {
            const res = await q.execute(
                'DELETE FROM project_audience_links WHERE project_id = ? AND workspace_id = ? AND site_id = ?',
                [projectId, workspaceId, siteId]
            );
            return res.affectedRows > 0;
        },
        async unlinkAllSites(projectId, workspaceId) {
            await q.execute('DELETE FROM project_audience_links WHERE project_id = ? AND workspace_id = ?', [
                projectId,
                workspaceId
            ]);
        },
        async listSiteUsage(siteId, workspaceId) {
            // L'étage ouvert seul, comme pour les bases, et les archivés à part : un
            // projet rangé ne suit plus rien à l'écran.
            return q.query<ProjectUsageRow>(
                `SELECT p.id AS project_id, p.status, p.content
                   FROM project_audience_links l
                   JOIN projects p ON p.id = l.project_id
                  WHERE l.site_id = ? AND l.workspace_id = ? AND p.security_tier = 'open'
                    AND p.archived_at IS NULL
                  ORDER BY p.sort_order ASC, p.id ASC`,
                [siteId, workspaceId]
            );
        },
        async detachSite(itemId, workspaceId) {
            const res = await q.execute('DELETE FROM project_audience_links WHERE site_id = ? AND workspace_id = ?', [
                itemId,
                workspaceId
            ]);
            return res.affectedRows;
        },
        async countSiteLinks(workspaceId) {
            // L'index de la table de liaison suffit, une requête pour tout l'espace.
            const rows = await q.query<Pick<ProjectAudienceLinkRow, 'site_id'> & { n: number }>(
                `SELECT l.site_id, COUNT(*) AS n
                   FROM project_audience_links l
                  WHERE l.workspace_id = ?
                  GROUP BY l.site_id`,
                [workspaceId]
            );
            return new Map(rows.map((row) => [Number(row.site_id), Number(row.n)]));
        }
    };
}
