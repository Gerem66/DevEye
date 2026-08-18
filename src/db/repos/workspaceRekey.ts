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
/**
 * Comment retrouver les lignes de l'espace.
 *
 * `workspace_id` — la table le porte elle-même, ce qui est le cas courant.
 * `audience_site` — la table ne connaît que son site, et c'est le site qui
 * porte l'espace. Plutôt que de dupliquer `workspace_id` sur une table qui
 * grandit vite (les libellés d'audience), on remonte par sous-requête : la
 * colonne dupliquée aurait été un second endroit où la vérité peut diverger.
 *
 * ⚠️ Ces clauses sont **interpolées** dans le SQL. Elles sont donc écrites ici,
 * une fois, et jamais construites depuis une donnée reçue.
 */
const SCOPE_WHERE = {
    workspace_id: 'workspace_id = ?',
    audience_site: 'site_id IN (SELECT id FROM audience_sites WHERE workspace_id = ?)'
} as const;

type EncryptedScope = keyof typeof SCOPE_WHERE;

interface EncryptedColumn {
    table: string;
    /** Colonne identifiante, pour cibler la mise à jour ligne par ligne. */
    id: string;
    column: string;
    /** Comment retrouver les lignes de l'espace. */
    scope: EncryptedScope;
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
    { table: 'uptime_settings', id: 'workspace_id', column: 'webhook_enc', scope: 'workspace_id', tier: 'open' },
    // Projets : l'étage est choisi **par projet**, alors qu'une entrée ici n'en
    // porte qu'un. C'est `blockers()` qui rend cette ligne vraie — il refuse la
    // conversion tant qu'un projet gardé subsiste, donc tout ce qui reste à
    // convertir est forcément sous l'étage ouvert.
    { table: 'projects', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    { table: 'project_columns', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    { table: 'project_cards', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    { table: 'project_messages', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    { table: 'project_milestones', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    { table: 'project_events', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    // Déploiement : la cible appartient à l'**espace** et non à un projet
    // (migration `080`), tout comme le dépôt git au-dessus. Elle n'a donc aucun
    // tier à suivre, et son historique non plus — `projectRekey` ne les connaît
    // plus ni l'un ni l'autre.
    { table: 'deploy_targets', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    { table: 'deployments', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    // Git : le dépôt appartient à l'**espace** et non à un projet (migration
    // `064`). Il n'a donc aucun tier à suivre, et tout son cache relève de cette
    // conversion-ci et d'elle seule — `projectRekey` ne le connaît plus.
    { table: 'git_repos', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    // `sync_state` et `last_sync_error` sont volontairement absents : éphémères,
    // réécrits en permanence par le service de fond. La conversion d'espace les
    // laisse tels quels ; la synchronisation suivante les remplace, et un ETag
    // illisible ne fait rien de pire qu'un 200 au lieu d'un 304.
    { table: 'git_commit_authors', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    { table: 'git_commits', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    { table: 'git_branches', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    { table: 'git_releases', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    { table: 'git_pull_requests', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    // Les secrets d'accès sont **toujours** sous l'étage ouvert, quel que soit
    // le tier des projets qui s'en servent : le service de fond les lit sans
    // session. Ils suivent donc la conversion d'espace, jamais celle d'un projet.
    { table: 'workspace_credentials', id: 'id', column: 'secret_enc', scope: 'workspace_id', tier: 'open' },
    // Bases de données (migration `068`). Comme les dépôts git, elles
    // appartiennent à l'espace et vivent toujours à l'étage ouvert.
    //
    // ⚠️ **Quatre colonnes par base**, dont deux secrets. En oublier une la
    // rendrait illisible après une conversion de clé, sans rien pour le
    // signaler : `content` cesserait d'afficher l'hôte, ou — bien pire — le
    // mot de passe deviendrait un octet mort et la base injoignable sans qu'on
    // sache pourquoi. `last_error` est volontairement absent : éphémère,
    // réécrit au relevé suivant.
    { table: 'database_connections', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    { table: 'database_connections', id: 'id', column: 'secret_enc', scope: 'workspace_id', tier: 'open' },
    { table: 'database_connections', id: 'id', column: 'access_content', scope: 'workspace_id', tier: 'open' },
    { table: 'database_connections', id: 'id', column: 'access_secret_enc', scope: 'workspace_id', tier: 'open' },
    { table: 'database_alerts', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    // Audience (migration `076`). Même famille que les dépôts et les bases : le
    // site appartient à l'espace et vit toujours à l'étage ouvert, parce que
    // l'ingestion publique le lit sans session.
    //
    // ⚠️ `audience_labels` n'a **pas** de `workspace_id` : un libellé pend à son
    // site, qui seul porte l'espace. La conversion le rejoint donc par jointure
    // (voir `scope: 'site'` plus bas). L'oublier ne casserait rien de visible
    // tout de suite — les nombres continueraient d'être justes — mais chaque
    // classement se viderait de ses intitulés, ce qui est la pire des deux
    // pannes : silencieuse, et découverte des semaines plus tard.
    { table: 'audience_sites', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    { table: 'audience_labels', id: 'id', column: 'content', scope: 'audience_site', tier: 'open' },
    // Les entonnoirs (migration `078`). Même portée : ils pendent à leur site.
    // Les oublier ne ferait perdre aucune mesure — un entonnoir n'est qu'une
    // lecture — mais laisserait un écran de marches sans intitulés, ce qui est
    // exactement aussi inutilisable.
    { table: 'audience_funnels', id: 'id', column: 'content', scope: 'audience_site', tier: 'open' },
    { table: 'audience_funnel_steps', id: 'id', column: 'content', scope: 'audience_site', tier: 'open' },
    // Les finances (migration `084`) : étage ouvert, comme tout ce qui
    // appartient à l'espace plutôt qu'à un projet. Les quatre colonnes
    // comptent, et en oublier une serait particulièrement sournois ici : les
    // soldes, les budgets et les graphes resteraient parfaitement justes (ils
    // n'agrègent que du clair) pendant que les intitulés, les tiers et les noms
    // de comptes deviendraient illisibles. Une panne qui ne se voit qu'à
    // l'écran, et jamais dans un total.
    { table: 'finance_accounts', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    { table: 'finance_categories', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    { table: 'finance_transactions', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' },
    { table: 'finance_recurring', id: 'id', column: 'content', scope: 'workspace_id', tier: 'open' }
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
                    `SELECT ${c.id} AS row_id, ${c.column} AS value FROM ${c.table} WHERE ${SCOPE_WHERE[c.scope]} AND ${c.column} IS NOT NULL AND ${c.column} <> ''`,
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

            // Un projet gardé est chiffré sous l'étage gardé du propriétaire, et
            // toute la liste ci-dessus le déclare « ouvert ». Le convertir tel
            // quel le rendrait illisible — et le convertir vraiment le rendrait
            // lisible par tous les membres, ce qui est précisément ce que son
            // auteur a refusé en le marquant confidentiel.
            const guarded = await pool.query<{ n: number }>(
                "SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ? AND security_tier = 'guarded'",
                [workspaceId]
            );
            if (Number(guarded.rows[0]?.n ?? 0) > 0) {
                found.push(
                    `${guarded.rows[0].n} projet(s) confidentiel(s) : repassez-les en standard avant la ` +
                        'conversion, sinon ils deviendraient lisibles par tous les membres.'
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
