import type { Queryable } from '../pool';

type Q = Queryable;

/**
 * La conversion d'un projet d'un étage de chiffrement vers l'autre : un seul
 * projet passe de l'étage ouvert à l'étage gardé (ou l'inverse) quand son
 * auteur change `security_tier`.
 *
 * ⚠️ **Liste à tenir à jour.** Toute nouvelle colonne chiffrée suspendue à un
 * projet doit y figurer, sinon son contenu resterait sous l'ancienne clé et
 * deviendrait illisible à la bascule. Rien ne peut le détecter : un blob chiffré
 * est indistinguable d'un autre.
 *
 * N'y figurent PAS, et c'est volontaire : les jetons des modules
 * (`ft_git_credentials.secret_enc`, `ft_deploy_credentials.secret_enc`), le
 * cache git (`git_*`) et le déploiement (`deploy_targets`, `deployments`),
 * toujours sous l'étage ouvert quel que soit le tier des projets qui s'y
 * rattachent : les services de fond doivent pouvoir les lire sans session.
 */
interface EncryptedCell {
    table: string;
    /**
     * Colonne identifiante, **unique à elle seule**. Aucune de ces tables n'a de
     * clé composite — cibler une ligne par deux colonnes n'est pas exprimable
     * ici, ce qui explique les clés de substitution ailleurs dans le schéma.
     */
    idColumn: string;
    column: string;
}

const COLUMNS: EncryptedCell[] = [
    { table: 'project_columns', idColumn: 'id', column: 'content' },
    { table: 'project_cards', idColumn: 'id', column: 'content' },
    { table: 'project_messages', idColumn: 'id', column: 'content' },
    { table: 'project_milestones', idColumn: 'id', column: 'content' },
    { table: 'project_events', idColumn: 'id', column: 'content' }
    // ⚠️ **Le cache git n'y figure plus, et ce n'est pas un oubli.** Depuis la
    // migration `064`, un dépôt appartient à l'espace et non à un projet : il
    // est chiffré à l'étage ouvert une fois pour toutes, et plusieurs projets
    // peuvent s'y rattacher. Il ne peut donc suivre le tier d'aucun d'eux. Un
    // projet qui passe en confidentiel **perd sa liaison** (voir
    // `projectSetSecurityTierFeature`) ; le dépôt et son cache, eux, ne bougent
    // pas.
    //
    // Effet de bord bienvenu : la course qui obligeait à effacer `sync_state` et
    // `last_sync_error` à chaque bascule a disparu avec sa cause — plus rien de
    // ce que le service de fond écrit ne traverse une conversion de projet.
    //
    // ⚠️ **Le déploiement n'y figure plus non plus**, et pour la même raison que
    // le git juste au-dessus : depuis la migration `080`, une cible appartient à
    // l'espace, plusieurs projets peuvent la déployer, et elle est chiffrée à
    // l'étage ouvert une fois pour toutes. Un projet qui passe en confidentiel
    // **perd sa liaison** ; la cible et son historique ne bougent pas.
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
