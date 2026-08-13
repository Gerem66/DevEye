import type { CredentialRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/**
 * Les jetons d'accès de l'espace, tous fournisseurs confondus.
 *
 * **Une table, deux propriétaires.** La forme d'un jeton ne dépend pas du
 * fournisseur (étiquette, adresse d'instance, secret), mais le droit d'y toucher
 * si : la feature Git n'expose que les jetons `github`, la feature Déploiement
 * que les clés `dokploy`. D'où le `provider` obligatoire sur chaque lecture —
 * ce dépôt ne rend **jamais** un jeton qu'on ne lui a pas demandé, ce qui rend
 * impossible de servir par mégarde la clé de production à l'écran des dépôts.
 *
 * Le secret est chiffré à l'étage **ouvert** : les deux services de fond qui
 * s'en servent tournent sans session.
 */
export interface CredentialsRepo {
    listByProvider(workspaceId: number, provider: string): Promise<CredentialRow[]>;
    /** Un jeton, à condition qu'il soit bien de ce fournisseur. */
    find(id: number, workspaceId: number, provider: string): Promise<CredentialRow | null>;
    /**
     * Un jeton sans égard au fournisseur, pour les seuls appelants qui savent
     * déjà lequel ils veulent : le service de fond, qui part d'une cible ou d'un
     * dépôt et remonte à sa clé.
     */
    findAny(id: number, workspaceId: number): Promise<CredentialRow | null>;
    create(input: {
        workspaceId: number;
        provider: string;
        label: string;
        baseUrl: string | null;
        secretEnc: string;
    }): Promise<CredentialRow>;
    update(
        id: number,
        workspaceId: number,
        provider: string,
        input: { label: string; baseUrl: string | null; secretEnc?: string }
    ): Promise<CredentialRow | null>;
    remove(id: number, workspaceId: number, provider: string): Promise<boolean>;
    /**
     * Combien d'objets s'appuient sur chaque jeton de ce fournisseur : des
     * dépôts pour GitHub, des cibles pour Dokploy. C'est ce chiffre qui dit à
     * l'écran ce qu'une suppression va couper, **avant** de cliquer.
     */
    countUses(workspaceId: number, provider: string): Promise<Map<number, number>>;
}

/** La table où l'on compte les usages, selon le fournisseur du jeton. */
const USERS_OF: Record<string, string> = {
    github: 'git_repos',
    dokploy: 'deploy_targets'
};

export function credentialsRepo(pool: Q): CredentialsRepo {
    return {
        async listByProvider(workspaceId, provider) {
            const r = await pool.query<CredentialRow>(
                'SELECT * FROM workspace_credentials WHERE workspace_id = ? AND provider = ? ORDER BY label ASC',
                [workspaceId, provider]
            );
            return r.rows;
        },
        async find(id, workspaceId, provider) {
            const r = await pool.query<CredentialRow>(
                'SELECT * FROM workspace_credentials WHERE id = ? AND workspace_id = ? AND provider = ?',
                [id, workspaceId, provider]
            );
            return r.rows[0] ?? null;
        },
        async findAny(id, workspaceId) {
            const r = await pool.query<CredentialRow>(
                'SELECT * FROM workspace_credentials WHERE id = ? AND workspace_id = ?',
                [id, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async create({ workspaceId, provider, label, baseUrl, secretEnc }) {
            const res = await pool.query(
                `INSERT INTO workspace_credentials (workspace_id, provider, label, base_url, secret_enc)
                 VALUES (?, ?, ?, ?, ?)`,
                [workspaceId, provider, label, baseUrl, secretEnc]
            );
            const r = await pool.query<CredentialRow>('SELECT * FROM workspace_credentials WHERE id = ?', [
                res.insertId
            ]);
            return r.rows[0];
        },
        async update(id, workspaceId, provider, { label, baseUrl, secretEnc }) {
            // Secret absent = on garde celui en place : le client ne le reçoit
            // jamais, il ne peut donc pas le renvoyer inchangé.
            const res = secretEnc
                ? await pool.query(
                      `UPDATE workspace_credentials SET label = ?, base_url = ?, secret_enc = ?
                        WHERE id = ? AND workspace_id = ? AND provider = ?`,
                      [label, baseUrl, secretEnc, id, workspaceId, provider]
                  )
                : await pool.query(
                      `UPDATE workspace_credentials SET label = ?, base_url = ?
                        WHERE id = ? AND workspace_id = ? AND provider = ?`,
                      [label, baseUrl, id, workspaceId, provider]
                  );
            if (res.rowCount === 0) return null;
            return this.find(id, workspaceId, provider);
        },
        async remove(id, workspaceId, provider) {
            const r = await pool.query(
                'DELETE FROM workspace_credentials WHERE id = ? AND workspace_id = ? AND provider = ?',
                [id, workspaceId, provider]
            );
            return r.rowCount > 0;
        },
        async countUses(workspaceId, provider) {
            const table = USERS_OF[provider];
            if (!table) return new Map();
            // Le nom de table vient de la constante ci-dessus, jamais de
            // l'appelant : il ne peut donc pas être autre chose que l'un des deux
            // littéraux, et l'interpolation est sûre. Les identifiants SQL ne
            // sont de toute façon pas paramétrables.
            const r = await pool.query<{ credential_id: number; uses: number }>(
                `SELECT credential_id, COUNT(*) AS uses FROM ${table}
                  WHERE workspace_id = ? AND credential_id IS NOT NULL
                  GROUP BY credential_id`,
                [workspaceId]
            );
            return new Map(r.rows.map((row) => [Number(row.credential_id), Number(row.uses)]));
        }
    };
}
