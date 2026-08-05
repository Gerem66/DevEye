import type { Queryable } from '../pool';

type Q = Queryable;

/**
 * Une colonne chiffrée à convertir lors du passage d'un espace à sa propre clé.
 *
 * ⚠️ **Liste à tenir à jour.** Toute nouvelle colonne chiffrée d'une table
 * rattachée à un espace doit y figurer, sinon son contenu deviendra illisible à
 * la conversion. Rien ne peut le détecter automatiquement : le chiffré est
 * indistinguable d'un blob quelconque.
 *
 * N'y figurent PAS, et c'est volontaire :
 *  - la météo (`api_key_enc`, `key_enc`) — chiffrée par la clé serveur
 *    directement (`ctx.crypt`), pas par une DEK ;
 *  - CloudSync — une BMK globale, indépendante des espaces ;
 *  - les tables filles du mail (dossiers, messages) — voir la garde préalable.
 */
interface EncryptedColumn {
    table: string;
    /** Colonne identifiante, pour cibler la mise à jour ligne par ligne. */
    id: string;
    column: string;
    /** Comment retrouver les lignes de l'espace. */
    scope: 'workspace_id';
    /**
     * Étage sous lequel la colonne a été écrite, donc celui qui sait la relire.
     * Se tromper ici ne corrompt rien — la relecture échoue et la conversion est
     * annulée — mais bloque la conversion pour de bon.
     */
    tier: 'guarded' | 'open';
}

const COLUMNS: EncryptedColumn[] = [
    // Le coffre passe toujours par l'étage gardé.
    { table: 'passwords', id: 'id', column: 'content', scope: 'workspace_id', tier: 'guarded' },
    // Notes et dossiers : étage ouvert. Une note privée passerait par l'étage
    // gardé, mais elles sont interdites en espace partagé et refusées en amont
    // par `blockers()`.
    { table: 'notes', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    { table: 'note_folders', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    // Uptime : étage ouvert, pour que l'ordonnanceur y travaille sans session.
    { table: 'uptime_services', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    { table: 'uptime_settings', id: 'workspace_id', column: 'email_enc', scope: 'workspace_id', tier: 'open' },
    { table: 'uptime_settings', id: 'workspace_id', column: 'webhook_enc', scope: 'workspace_id', tier: 'open' }
];

export interface EncryptedCell {
    table: string;
    id: string | number;
    column: string;
    value: string;
    tier: 'guarded' | 'open';
}

export interface WorkspaceRekeyRepo {
    /** Toutes les valeurs chiffrées de l'espace, prêtes à être converties. */
    readAll(workspaceId: number): Promise<EncryptedCell[]>;
    write(cell: EncryptedCell): Promise<void>;
    /**
     * Ce qui empêcherait une conversion propre, en clair pour l'utilisateur.
     * Vide = la conversion peut avoir lieu.
     */
    blockers(workspaceId: number): Promise<string[]>;
}

export function workspaceRekeyRepo(pool: Q): WorkspaceRekeyRepo {
    return {
        async readAll(workspaceId) {
            const cells: EncryptedCell[] = [];
            for (const c of COLUMNS) {
                const r = await pool.query<Record<string, string | number | null>>(
                    `SELECT ${c.id} AS row_id, ${c.column} AS value FROM ${c.table} WHERE ${c.scope} = ? AND ${c.column} IS NOT NULL AND ${c.column} <> ''`,
                    [workspaceId]
                );
                for (const row of r.rows) {
                    cells.push({
                        table: c.table,
                        id: row.row_id as string | number,
                        column: c.column,
                        value: String(row.value),
                        tier: c.tier
                    });
                }
            }
            return cells;
        },
        async write({ table, id, column, value }) {
            const meta = COLUMNS.find((c) => c.table === table && c.column === column);
            // Garde-fou : `table` et `column` sont interpolés dans le SQL, ils ne
            // doivent venir que de la liste ci-dessus, jamais d'une entrée.
            if (!meta) throw new Error(`Unknown encrypted column ${table}.${column}`);
            await pool.query(`UPDATE ${meta.table} SET ${meta.column} = ? WHERE ${meta.id} = ?`, [value, id]);
        },
        async blockers(workspaceId) {
            const found: string[] = [];

            // Une note privée est chiffrée sous l'étage gardé du propriétaire.
            // La convertir sous la clé d'espace la rendrait lisible par tous les
            // membres — un changement de sens qu'on ne fait pas dans le dos de
            // son auteur.
            const priv = await pool.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM notes WHERE workspace_id = ? AND is_private = 1',
                [workspaceId]
            );
            if (Number(priv.rows[0]?.n ?? 0) > 0) {
                found.push(
                    `${priv.rows[0].n} note(s) privée(s) : rendez-les publiques avant la conversion, ` +
                        'sinon elles deviendraient lisibles par tous les membres.'
                );
            }

            // Le mail porte un arbre entier (comptes, dossiers, messages) avec sa
            // propre logique de re-chiffrement. Le convertir ici en dupliquerait
            // la moitié : on refuse plutôt que d'en produire une seconde version.
            const mail = await pool.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM mail_accounts WHERE workspace_id = ?',
                [workspaceId]
            );
            if (Number(mail.rows[0]?.n ?? 0) > 0) {
                found.push(
                    `${mail.rows[0].n} compte(s) mail : déplacez-les dans votre espace personnel avant la conversion.`
                );
            }

            return found;
        }
    };
}
