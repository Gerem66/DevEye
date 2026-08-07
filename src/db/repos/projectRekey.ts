import type { Queryable } from '../pool';

type Q = Queryable;

/**
 * La conversion d'un projet d'un étage de chiffrement vers l'autre.
 *
 * Même mécanique que `workspaceRekey.ts`, à une maille plus fine : là-bas c'est
 * un espace entier qui passe sous sa propre clé, ici c'est un seul projet qui
 * passe de l'étage ouvert à l'étage gardé (ou l'inverse) quand son auteur change
 * `security_tier`.
 *
 * ⚠️ **Liste à tenir à jour.** Toute nouvelle colonne chiffrée suspendue à un
 * projet doit y figurer, sinon son contenu resterait sous l'ancienne clé et
 * deviendrait illisible à la bascule. Rien ne peut le détecter : un blob chiffré
 * est indistinguable d'un autre.
 *
 * N'y figure PAS, et c'est volontaire : `project_credentials.secret_enc`, qui
 * est toujours sous l'étage ouvert quel que soit le tier du projet — le service
 * de fond doit pouvoir le lire sans session. Il relève de `workspaceRekey`.
 */
interface EncryptedCell {
    table: string;
    /**
     * Colonne identifiante, **unique à elle seule**. Toutes ces tables n'ont pas
     * de `id` : `project_repos` et `project_deploy_targets` sont clés sur
     * `project_id`. Aucune n'a de clé composite — c'est précisément pourquoi
     * `project_commit_authors` porte une clé de substitution (voir la migration
     * `061`) : cibler une ligne par deux colonnes n'est pas exprimable ici.
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
    // Intégrations : le cache git suit le tier du projet comme le reste.
    { table: 'project_repos', idColumn: 'project_id', column: 'content' },
    // ⚠️ `sync_state` et `last_sync_error` n'y figurent **pas**, et ce n'est pas
    // un oubli. Ce sont des données éphémères — des ETags et un message
    // transitoire — que le service de fond réécrit **toujours à l'étage
    // ouvert**. Or, pendant la conversion, la ligne `projects` porte encore
    // l'ancien tier : le service a donc parfaitement le droit d'écrire entre la
    // lecture et l'écriture de la conversion, et déposerait un blob sous
    // l'ancienne clé au milieu d'un arbre déjà converti. La conversion suivante
    // resterait alors bloquée pour de bon sur une ligne illisible (course
    // observée en test, pas théorique).
    //
    // Plutôt que d'ajouter un verrou, on les **efface** à la bascule
    // (`clearSyncState`). Le coût est nul : la synchronisation suivante refera
    // une requête sans ETag, et le message d'erreur n'avait de sens que pour le
    // tour passé.
    { table: 'project_commit_authors', idColumn: 'id', column: 'content' },
    { table: 'project_commits', idColumn: 'id', column: 'content' },
    { table: 'project_branches', idColumn: 'id', column: 'content' },
    { table: 'project_releases', idColumn: 'id', column: 'content' },
    { table: 'project_deploy_targets', idColumn: 'project_id', column: 'content' },
    { table: 'project_deployments', idColumn: 'id', column: 'content' }
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

export function projectRekeyRepo(pool: Q): ProjectRekeyRepo {
    return {
        async readTree(projectId, workspaceId) {
            const cells: ProjectEncryptedCell[] = [];
            for (const c of COLUMNS) {
                // Les colonnes nullables (sync_state, last_sync_error) n'ont
                // rien à convertir quand elles sont vides.
                const r = await pool.query<Record<string, string | number | null>>(
                    `SELECT ${c.idColumn} AS row_id, ${c.column} AS value FROM ${c.table}
                     WHERE project_id = ? AND workspace_id = ? AND ${c.column} IS NOT NULL AND ${c.column} <> ''`,
                    [projectId, workspaceId]
                );
                for (const row of r.rows) {
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
            // interpolés dans le SQL ; ils ne doivent venir que de la liste
            // ci-dessus, jamais d'une entrée.
            const c = meta(table, column);
            if (!c) throw new Error(`Unknown project encrypted column ${table}.${column}`);
            // `project_id` dans le WHERE même quand l'identifiant suffit : c'est
            // ce qui rend une conversion incapable de déborder sur un autre
            // projet, quoi qu'il arrive en amont.
            await pool.query(`UPDATE ${c.table} SET ${c.column} = ? WHERE ${c.idColumn} = ? AND project_id = ?`, [
                value,
                id,
                projectId
            ]);
        }
    };
}
