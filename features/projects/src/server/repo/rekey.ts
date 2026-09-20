import type { SdkQueryable } from '@deveye/types/sdk/server';

/**
 * La conversion d'un projet d'un étage de chiffrement vers l'autre, quand son auteur
 * change `security_tier`.
 *
 * ⚠️ Liste à tenir à jour : toute nouvelle colonne chiffrée suspendue à un projet
 * doit y figurer, sinon son contenu reste sous l'ancienne clé et devient illisible à
 * la bascule. Rien ne peut le détecter, un blob chiffré est indistinguable d'un
 * autre.
 *
 * N'y figurent pas, volontairement : les jetons des modules, le cache git et le
 * déploiement, toujours sous l'étage ouvert quel que soit le palier des projets qui
 * s'y rattachent, les services de fond devant les lire sans session.
 */
interface EncryptedCell {
    table: string;
    /**
     * Colonne identifiante, unique à elle seule : cibler une ligne par deux colonnes
     * n'est pas exprimable ici.
     */
    idColumn: string;
    column: string;
}

const COLUMNS: EncryptedCell[] = [
    { table: 'project_columns', idColumn: 'id', column: 'content' },
    { table: 'project_cards', idColumn: 'id', column: 'content' },
    { table: 'project_messages', idColumn: 'id', column: 'content' },
    { table: 'project_milestones', idColumn: 'id', column: 'content' },
    { table: 'project_events', idColumn: 'id', column: 'content' },
    // Les tuiles automatiques ont un `content` vide : la lecture les saute
    // d'elle-même, seuls les indicateurs sur mesure ont une requête à convertir.
    { table: 'ft_projects_dashboard_tiles', idColumn: 'id', column: 'content' }
    // ⚠️ Ni le cache git ni le déploiement n'y figurent, et ce n'est pas un oubli :
    // un dépôt comme une cible appartient à l'espace, plusieurs projets peuvent s'y
    // rattacher, et l'un et l'autre sont chiffrés à l'étage ouvert une fois pour
    // toutes. Ils ne peuvent donc suivre le palier d'aucun projet ; celui qui passe
    // en confidentiel perd sa liaison, le dépôt et la cible ne bougent pas.
];

export interface ProjectEncryptedCell {
    table: string;
    column: string;
    id: string | number;
    value: string;
}

export interface ProjectRekeyRepo {
    /** Toutes les valeurs chiffrées suspendues au projet, prêtes à être converties. */
    readTree(projectId: number, workspaceId: number): Promise<ProjectEncryptedCell[]>;
    write(projectId: number, cell: ProjectEncryptedCell): Promise<void>;
}

function meta(table: string, column: string): EncryptedCell | undefined {
    return COLUMNS.find((c) => c.table === table && c.column === column);
}

export function projectRekeyRepo(q: SdkQueryable): ProjectRekeyRepo {
    return {
        async readTree(projectId, workspaceId) {
            const cells: ProjectEncryptedCell[] = [];
            for (const c of COLUMNS) {
                // Une cellule vide n'a rien à convertir.
                const rows = await q.query<Record<string, string | number | null>>(
                    `SELECT ${c.idColumn} AS row_id, ${c.column} AS value FROM ${c.table}
                     WHERE project_id = ? AND workspace_id = ? AND ${c.column} IS NOT NULL AND ${c.column} <> ''`,
                    [projectId, workspaceId]
                );
                for (const row of rows) {
                    cells.push({
                        table: c.table,
                        column: c.column,
                        id: row.row_id as string | number,
                        value: String(row.value)
                    });
                }
            }
            return cells;
        },
        async write(projectId, { table, column, id, value }) {
            // Garde-fou : `table`, `column` et la colonne identifiante sont
            // interpolés dans le SQL, ils ne peuvent venir que de la liste ci-dessus.
            const c = meta(table, column);
            if (!c) throw new Error(`Unknown project encrypted column ${table}.${column}`);
            // `project_id` dans le WHERE même quand l'identifiant suffit : une
            // conversion ne peut alors pas déborder sur un autre projet.
            await q.execute(`UPDATE ${c.table} SET ${c.column} = ? WHERE ${c.idColumn} = ? AND project_id = ?`, [
                value,
                id,
                projectId
            ]);
        }
    };
}
