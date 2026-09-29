import type { FeatureItemsCopy, ItemTree, SdkQueryable } from '@deveye/types/sdk/server';

import type { ProjectsRepo } from './repo';

/**
 * Ce dont un projet est fait : tout son arbre, colonnes, jalons, cartes,
 * dépendances, messages, tuiles du tableau de bord et frise. C'est la liste que le déplacement rescelle et
 * que la copie emporte.
 *
 * ⚠️ À tenir à jour, comme celle de `repo/rekey.ts` qu'elle double pour un autre
 * geste : toute nouvelle colonne chiffrée suspendue à un projet doit y figurer
 * (`sealed`), sinon un déplacement la laisse sous l'ancienne clé, où elle
 * devient illisible, et une copie l'emporte sous une clé que la destination n'a
 * pas. Rien ne peut le détecter, un blob chiffré est indistinguable d'un autre.
 */
export const projectsTree: ItemTree = [
    {
        table: 'projects',
        idColumn: 'id',
        ownerColumn: 'id',
        workspaceColumn: 'workspace_id',
        userColumn: 'user_id',
        orderColumn: 'sort_order',
        sealed: ['content'],
        omit: ['created', 'updated'],
        tier: { column: 'security_tier', open: 'open', private: 'guarded' }
    },
    {
        table: 'project_columns',
        idColumn: 'id',
        ownerColumn: 'project_id',
        workspaceColumn: 'workspace_id',
        sealed: ['content']
    },
    {
        table: 'project_milestones',
        idColumn: 'id',
        ownerColumn: 'project_id',
        workspaceColumn: 'workspace_id',
        sealed: ['content']
    },
    {
        table: 'project_cards',
        idColumn: 'id',
        ownerColumn: 'project_id',
        workspaceColumn: 'workspace_id',
        refs: { column_id: 'project_columns', milestone_id: 'project_milestones' },
        sealed: ['content'],
        // Un compte d'ici n'existe pas forcément là où la copie arrive.
        omit: ['author_user_id', 'assignee_user_id']
    },
    {
        table: 'project_card_deps',
        ownerColumn: 'project_id',
        refs: { card_id: 'project_cards', blocked_by_card_id: 'project_cards' }
    },
    {
        table: 'project_messages',
        idColumn: 'id',
        ownerColumn: 'project_id',
        workspaceColumn: 'workspace_id',
        refs: { card_id: 'project_cards' },
        sealed: ['content'],
        omit: ['author_user_id', 'mentions']
    },
    {
        table: 'ft_projects_dashboard_tiles',
        idColumn: 'id',
        ownerColumn: 'project_id',
        workspaceColumn: 'workspace_id',
        sealed: ['content'],
        // La base que mesure un indicateur appartient à l'espace quitté, et sa
        // dernière mesure à ce serveur.
        omit: ['database_id', 'last_number', 'last_error', 'last_check_at']
    },
    // La frise désigne cartes et jalons par des ids sans table nommée
    // (`ref_type`, `ref_id`), que rien ne saurait réécrire : elle reste l'histoire
    // de l'original.
    { table: 'project_events', idColumn: 'id', ownerColumn: 'project_id', sealed: ['content'], cache: true }
];

/** Les six familles de liaison : ce que le projet relie ne le suit pas. */
const LINK_TABLES = [
    'project_uptime_links',
    'project_database_links',
    'project_deploy_links',
    'project_repo_links',
    'project_audience_links',
    'ft_projects_hosting_links'
];

async function linked(q: SdkQueryable, projectId: number): Promise<number> {
    let total = 0;
    for (const table of LINK_TABLES) {
        const rows = await q.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, [
            projectId
        ]);
        total += Number(rows[0]?.n ?? 0);
    }
    return total;
}

export const projectsCopy: FeatureItemsCopy<ProjectsRepo> = {
    tree: projectsTree,
    async plan({ q, itemId }) {
        const links = await linked(q, Number(itemId));
        return {
            blockers: [],
            drops: [
                'Les auteurs des cartes et des messages, leurs assignations et leurs mentions',
                'Sa frise d’activité',
                'Les bases que mesurent ses indicateurs, à rattacher là-bas',
                ...(links > 0 ? ['Ses liaisons vers les éléments de cet espace (services, bases, dépôts…)'] : [])
            ]
        };
    }
};
