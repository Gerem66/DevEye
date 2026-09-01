import {
    countMovableCells,
    FeatureError,
    resealCells,
    type FeatureItemsMove,
    type MovableCell,
    type SdkQueryable
} from '@deveye/types/sdk/server';

import type { ProjectsRepo } from './repo';

/**
 * Le changement d'espace d'un projet : tout son arbre, colonnes, cartes,
 * messages, jalons et frise. Un projet gardé est refusé en amont par
 * `shareable` : il est chiffré par le mot de passe de son auteur, et le palier
 * gardé n'existe pas dans un espace partagé.
 *
 * ⚠️ Liste à tenir à jour, comme celle de `repo/rekey.ts` qu'elle double pour
 * un autre geste : toute nouvelle colonne chiffrée suspendue à un projet doit y
 * figurer, sinon son contenu reste sous l'ancienne clé et devient illisible.
 * Rien ne peut le détecter, un blob chiffré est indistinguable d'un autre.
 */
const CELLS: readonly MovableCell[] = [
    { table: 'projects', idColumn: 'id', ownerColumn: 'id', column: 'content' },
    { table: 'project_columns', idColumn: 'id', ownerColumn: 'project_id', column: 'content' },
    { table: 'project_cards', idColumn: 'id', ownerColumn: 'project_id', column: 'content' },
    { table: 'project_messages', idColumn: 'id', ownerColumn: 'project_id', column: 'content' },
    { table: 'project_milestones', idColumn: 'id', ownerColumn: 'project_id', column: 'content' },
    { table: 'project_events', idColumn: 'id', ownerColumn: 'project_id', column: 'content' }
];

/** Les tables de l'arbre qui portent leur propre espace, et doivent suivre. */
const OWNED_TABLES = ['project_columns', 'project_cards', 'project_messages', 'project_milestones', 'project_events'];

/**
 * Les cinq familles de liaison, qui appartiennent à Projets. Une liaison ne
 * traverse pas une frontière d'espace : ce que le projet reliait ici reste ici,
 * et la liaison part.
 */
const LINK_TABLES = [
    { table: 'project_uptime_links', label: 'services surveillés' },
    { table: 'project_database_links', label: 'bases de données' },
    { table: 'project_deploy_links', label: 'cibles de déploiement' },
    { table: 'project_repo_links', label: 'dépôts git' },
    { table: 'project_audience_links', label: 'sites suivis' }
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
