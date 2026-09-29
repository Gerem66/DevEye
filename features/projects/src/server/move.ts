import {
    countMovableCells,
    FeatureError,
    movableCellsOf,
    resealCells,
    type FeatureItemsMove,
    type SdkQueryable
} from '@deveye/types/sdk/server';

import type { ProjectsRepo } from './repo';
import { projectsTree } from './copy';
import { forgetPublicPage } from './publication';

/**
 * Le changement d'espace d'un projet : tout son arbre, colonnes, cartes,
 * messages, jalons et frise. Un projet gardé est refusé en amont par
 * `shareable` : il est chiffré par le mot de passe de son auteur, et le palier
 * gardé n'existe pas dans un espace partagé.
 *
 * Les cellules à resceller viennent de l'arbre de `copy.ts`, la seule liste à tenir.
 */
const CELLS = movableCellsOf(projectsTree);

/** Les tables de l'arbre qui portent leur propre espace, et doivent suivre. */
const OWNED_TABLES = [
    'project_columns',
    'project_cards',
    'project_messages',
    'project_milestones',
    'project_events',
    'ft_projects_dashboard_tiles'
];

/**
 * Les six familles de liaison, qui appartiennent à Projets. Une liaison ne
 * traverse pas une frontière d'espace : ce que le projet reliait ici reste ici,
 * et la liaison part.
 */
const LINK_TABLES = [
    { table: 'project_uptime_links', label: 'services surveillés' },
    { table: 'project_database_links', label: 'bases de données' },
    { table: 'project_deploy_links', label: 'cibles de déploiement' },
    { table: 'project_repo_links', label: 'dépôts git' },
    { table: 'project_audience_links', label: 'sites suivis' },
    { table: 'ft_projects_hosting_links', label: 'dossiers' }
];

/** Ce que le projet relie, par famille : de quoi nommer ce qu'il va perdre. */
async function linkCounts(q: SdkQueryable, projectId: number, workspaceId: number): Promise<string[]> {
    const out: string[] = [];
    for (const { table, label } of LINK_TABLES) {
        const rows = await q.query<{ n: number }>(
            `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ? AND workspace_id = ?`,
            [projectId, workspaceId]
        );
        const n = Number(rows[0]?.n ?? 0);
        if (n > 0)
            out.push(n === 1 ? `Sa liaison vers un des ${label} d’ici` : `Ses ${n} liaisons vers les ${label} d’ici`);
    }
    // Les indicateurs sur mesure gardent leur requête mais perdent leur base,
    // qui reste ici : le dire avant, pas après.
    const kpis = await q.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ft_projects_dashboard_tiles
          WHERE project_id = ? AND workspace_id = ? AND database_id IS NOT NULL`,
        [projectId, workspaceId]
    );
    const k = Number(kpis[0]?.n ?? 0);
    if (k > 0) {
        out.push(
            k === 1
                ? 'La base de son indicateur sur mesure, à redésigner là-bas'
                : `Les bases de ses ${k} indicateurs sur mesure, à redésigner là-bas`
        );
    }
    const published = await q.query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM ft_projects_public WHERE project_id = ? AND enabled = 1',
        [projectId]
    );
    if (Number(published[0]?.n ?? 0) > 0) out.push('Sa page publique : le lien donné cessera de répondre');
    return out;
}

export const projectsMove: FeatureItemsMove<ProjectsRepo> = {
    async plan({ q, itemId, fromWorkspaceId }) {
        const projectId = Number(itemId);
        return {
            blockers: [],
            drops: await linkCounts(q, projectId, fromWorkspaceId),
            rows: await countMovableCells(q, CELLS, projectId)
        };
    },

    async apply({ q, itemId, fromWorkspaceId, toWorkspaceId, ciphers }) {
        const projectId = Number(itemId);
        await resealCells(q, CELLS, projectId, ciphers);

        // Ce que le projet reliait reste dans l'espace quitté : la liaison part
        // avec lui plutôt que de désigner, depuis là-bas, un élément d'ici.
        for (const { table } of LINK_TABLES) {
            await q.execute(`DELETE FROM ${table} WHERE project_id = ? AND workspace_id = ?`, [
                projectId,
                fromWorkspaceId
            ]);
        }

        // La page publique tient à l'offre et aux domaines de l'espace quitté : elle
        // reste ici, comme une liaison, et son lien cesse de répondre.
        await q.execute('DELETE FROM ft_projects_public WHERE project_id = ?', [projectId]);
        forgetPublicPage(projectId);

        // Un indicateur perd sa base pour la même raison, mais garde sa requête :
        // c'est du travail, et la tuile dira qu'il lui faut une base d'ici.
        await q.execute(
            'UPDATE ft_projects_dashboard_tiles SET database_id = NULL WHERE project_id = ? AND workspace_id = ?',
            [projectId, fromWorkspaceId]
        );

        for (const table of OWNED_TABLES) {
            await q.execute(`UPDATE ${table} SET workspace_id = ? WHERE project_id = ? AND workspace_id = ?`, [
                toWorkspaceId,
                projectId,
                fromWorkspaceId
            ]);
        }
        // Les points de lecture pendent aux cartes, pas au projet : sans ce
        // passage, le badge « non lu » se réglerait encore sur l'espace quitté.
        await q.execute(
            `UPDATE project_card_reads SET workspace_id = ?
              WHERE workspace_id = ? AND card_id IN (SELECT id FROM project_cards WHERE project_id = ?)`,
            [toWorkspaceId, fromWorkspaceId, projectId]
        );

        const next = await q.query<{ next: number }>(
            'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM projects WHERE workspace_id = ?',
            [toWorkspaceId]
        );
        const res = await q.execute(
            'UPDATE projects SET workspace_id = ?, sort_order = ? WHERE id = ? AND workspace_id = ?',
            [toWorkspaceId, Number(next[0]?.next ?? 0), projectId, fromWorkspaceId]
        );
        if (res.affectedRows !== 1) {
            throw new FeatureError('not_found', 'Ce projet n’est plus dans cet espace : déplacement annulé.');
        }
    }
};
