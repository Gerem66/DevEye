import type {
    GitBranchRow,
    GitCommitAuthorRow,
    GitCommitRow,
    GitCredentialRow,
    GitPullRequestRow,
    GitReleaseRow,
    GitRepoRow,
    ProjectRepoLinkRow
} from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/** Un point du graphe, tel que SQL le rend — sans rien déchiffrer. */
export interface CommitPointRow {
    sha: string;
    committed_at: number;
    author_ref: string;
}

export interface AuthorStatRow {
    author_ref: string;
    commit_count: number;
}

/** Un dépôt, plus le nombre de projets qui s'en servent. */
export interface GitRepoWithUsageRow extends GitRepoRow {
    project_count: number;
}

/** Un projet lié à un dépôt, tel que la jointure le rend. */
export interface GitRepoUsageRow {
    project_id: number;
    status: string;
    content: string;
}

export interface GitRepo {
    // -- identifiants d'accès (portée : l'espace) --------------------------
    listCredentials(workspaceId: number): Promise<GitCredentialRow[]>;
    findCredential(id: number, workspaceId: number): Promise<GitCredentialRow | null>;
    createCredential(input: {
        workspaceId: number;
        provider: string;
        label: string;
        baseUrl: string | null;
        secretEnc: string;
    }): Promise<GitCredentialRow>;
    updateCredential(
        id: number,
        workspaceId: number,
        input: { label: string; baseUrl: string | null; secretEnc?: string }
    ): Promise<GitCredentialRow | null>;
    deleteCredential(id: number, workspaceId: number): Promise<boolean>;
    /** Combien de dépôts et de cibles de déploiement s'appuient sur ce jeton. */
    countCredentialUses(workspaceId: number): Promise<Map<number, number>>;

    // -- dépôts ------------------------------------------------------------
    listRepos(workspaceId: number): Promise<GitRepoWithUsageRow[]>;
    findRepo(id: number, workspaceId: number): Promise<GitRepoRow | null>;
    findRepoWithUsage(id: number, workspaceId: number): Promise<GitRepoWithUsageRow | null>;
    /** L'unicité d'un dépôt dans l'espace, ce que `content` chiffré ne peut porter. */
    findRepoBySlug(workspaceId: number, slugRef: string): Promise<GitRepoRow | null>;
    countRepos(workspaceId: number): Promise<number>;
    createRepo(input: {
        workspaceId: number;
        provider: string;
        slugRef: string;
        credentialId: number | null;
        content: string;
    }): Promise<GitRepoRow>;
    updateRepo(
        id: number,
        workspaceId: number,
        input: { credentialId: number | null; enabled: boolean }
    ): Promise<GitRepoRow | null>;
    deleteRepo(id: number, workspaceId: number): Promise<boolean>;
    /**
     * Range les dépôts de l'espace : `ids` est la liste complète, rang = indice.
     *
     * Ne touche à rien d'autre — ni jeton, ni état de synchronisation : ranger
     * n'est pas configurer, et un glisser-déposer ne doit pas relancer une
     * lecture chez le fournisseur.
     */
    reorderRepos(workspaceId: number, ids: number[]): Promise<void>;
    /** Les projets qui utilisent ce dépôt — le titre reste à déchiffrer. */
    listUsage(repoId: number, workspaceId: number): Promise<GitRepoUsageRow[]>;

    // -- liaison projet → dépôt -------------------------------------------
    findLink(projectId: number, workspaceId: number): Promise<ProjectRepoLinkRow | null>;
    linkProject(projectId: number, workspaceId: number, repoId: number): Promise<void>;
    unlinkProject(projectId: number, workspaceId: number): Promise<boolean>;

    // -- synchronisation ---------------------------------------------------
    /** Résultat d'un tour de synchronisation : succès (erreur nulle) ou échec. */
    markSynced(
        repoId: number,
        input: { at: number | null; error: string | null; syncState: string | null; defaultBranch?: string | null }
    ): Promise<void>;
    /** Les dépôts que l'ordonnanceur doit traiter, les plus en retard d'abord. */
    listDue(limit: number): Promise<GitRepoRow[]>;
    /**
     * Jette le cache d'un dépôt pour qu'il soit relu entièrement.
     *
     * Les **auteurs sont épargnés** : leur rattachement à un membre de l'espace
     * est du travail fait à la main, que rien ne permettrait de reconstituer.
     * Leurs lignes seront simplement réécrites par la synchronisation suivante
     * (`upsertAuthor` ne touche jamais `user_id`).
     */
    resetCache(repoId: number, workspaceId: number): Promise<boolean>;

    // -- cache git ---------------------------------------------------------
    upsertBranch(input: {
        repoId: number;
        workspaceId: number;
        nameRef: string;
        headSha: string | null;
        isDefault: boolean;
        updatedAt: number | null;
        content: string;
    }): Promise<void>;
    /** Retire les branches disparues du distant. */
    pruneBranches(repoId: number, keepRefs: string[]): Promise<void>;
    listBranches(repoId: number, workspaceId: number): Promise<GitBranchRow[]>;
    /**
     * Inscrit l'avance-retard d'une branche, avec le couple de sha qui l'a
     * produit — c'est lui qui dira, au tour suivant, si le calcul tient encore.
     */
    setBranchComparison(
        repoId: number,
        nameRef: string,
        input: { ahead: number; behind: number; comparedSha: string }
    ): Promise<void>;

    upsertPullRequest(input: {
        repoId: number;
        workspaceId: number;
        number: number;
        state: string;
        authorRef: string | null;
        createdAt: number;
        updatedAt: number;
        mergedAt: number | null;
        closedAt: number | null;
        content: string;
    }): Promise<void>;
    listPullRequests(repoId: number, workspaceId: number): Promise<GitPullRequestRow[]>;

    upsertAuthor(input: { repoId: number; workspaceId: number; authorRef: string; content: string }): Promise<void>;
    listAuthors(repoId: number, workspaceId: number): Promise<GitCommitAuthorRow[]>;
    setAuthorUser(repoId: number, workspaceId: number, authorRef: string, userId: number | null): Promise<boolean>;

    insertCommit(input: {
        repoId: number;
        workspaceId: number;
        sha: string;
        committedAt: number;
        authorRef: string;
        parents: string[];
        content: string;
    }): Promise<void>;
    listCommits(
        repoId: number,
        workspaceId: number,
        before: { committedAt: number; id: number } | null,
        limit: number
    ): Promise<GitCommitRow[]>;
    /** Tous les points du graphe, colonnes claires uniquement. */
    listCommitPoints(repoId: number, workspaceId: number, limit: number): Promise<CommitPointRow[]>;
    commitStats(
        repoId: number,
        workspaceId: number
    ): Promise<{ total: number; firstAt: number | null; lastAt: number | null }>;
    authorStats(repoId: number, workspaceId: number): Promise<AuthorStatRow[]>;
    /** Horodatage du commit le plus récent connu, pour reprendre la lecture. */
    latestCommitAt(repoId: number): Promise<number | null>;
    /**
     * Ce commit est-il déjà en cache ?
     *
     * Sert à sauter les branches qui n'ont pas bougé : si l'on connaît déjà la
     * tête d'une branche, on connaît tout ce qu'elle porte. En régime établi,
     * c'est ce qui ramène le balayage des branches à zéro requête.
     */
    hasCommit(repoId: number, sha: string): Promise<boolean>;

    upsertRelease(input: {
        repoId: number;
        workspaceId: number;
        tagRef: string;
        publishedAt: number;
        isPrerelease: boolean;
        content: string;
    }): Promise<void>;
    listReleases(repoId: number, workspaceId: number): Promise<GitReleaseRow[]>;
}

export function gitRepo(pool: Q): GitRepo {
    return {
        async listCredentials(workspaceId) {
            const r = await pool.query<GitCredentialRow>(
                'SELECT * FROM project_credentials WHERE workspace_id = ? ORDER BY provider ASC, label ASC',
                [workspaceId]
            );
            return r.rows;
        },
        async findCredential(id, workspaceId) {
            const r = await pool.query<GitCredentialRow>(
                'SELECT * FROM project_credentials WHERE id = ? AND workspace_id = ?',
                [id, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async createCredential({ workspaceId, provider, label, baseUrl, secretEnc }) {
            const res = await pool.query(
                `INSERT INTO project_credentials (workspace_id, provider, label, base_url, secret_enc)
                 VALUES (?, ?, ?, ?, ?)`,
                [workspaceId, provider, label, baseUrl, secretEnc]
            );
            const r = await pool.query<GitCredentialRow>('SELECT * FROM project_credentials WHERE id = ?', [
                res.insertId
            ]);
            return r.rows[0];
        },
        async updateCredential(id, workspaceId, { label, baseUrl, secretEnc }) {
            // Secret absent = on garde celui en place : le client ne le reçoit
            // jamais, il ne peut donc pas le renvoyer inchangé.
            const res = secretEnc
                ? await pool.query(
                      'UPDATE project_credentials SET label = ?, base_url = ?, secret_enc = ? WHERE id = ? AND workspace_id = ?',
                      [label, baseUrl, secretEnc, id, workspaceId]
                  )
                : await pool.query(
                      'UPDATE project_credentials SET label = ?, base_url = ? WHERE id = ? AND workspace_id = ?',
                      [label, baseUrl, id, workspaceId]
                  );
            if (res.rowCount === 0) return null;
            return this.findCredential(id, workspaceId);
        },
        async deleteCredential(id, workspaceId) {
            const r = await pool.query('DELETE FROM project_credentials WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return r.rowCount > 0;
        },
        async countCredentialUses(workspaceId) {
            // Les deux consommateurs d'un jeton, en une requête : un dépôt git
            // et une cible de déploiement. C'est ce chiffre qui dit à l'écran ce
            // qu'une suppression va couper.
            const r = await pool.query<{ credential_id: number; uses: number }>(
                `SELECT credential_id, SUM(n) AS uses FROM (
                     SELECT credential_id, COUNT(*) AS n FROM git_repos
                      WHERE workspace_id = ? AND credential_id IS NOT NULL GROUP BY credential_id
                     UNION ALL
                     SELECT credential_id, COUNT(*) AS n FROM project_deploy_targets
                      WHERE workspace_id = ? AND credential_id IS NOT NULL GROUP BY credential_id
                 ) t GROUP BY credential_id`,
                [workspaceId, workspaceId]
            );
            return new Map(r.rows.map((row) => [Number(row.credential_id), Number(row.uses)]));
        },

        async listRepos(workspaceId) {
            const r = await pool.query<GitRepoWithUsageRow>(
                `SELECT r.*, COUNT(l.project_id) AS project_count
                   FROM git_repos r
                   LEFT JOIN project_repo_links l ON l.repo_id = r.id
                  WHERE r.workspace_id = ?
                  GROUP BY r.id
                  ORDER BY r.sort_order ASC, r.id ASC`,
                [workspaceId]
            );
            return r.rows.map((row) => ({ ...row, project_count: Number(row.project_count) }));
        },
        async findRepo(id, workspaceId) {
            const r = await pool.query<GitRepoRow>('SELECT * FROM git_repos WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return r.rows[0] ?? null;
        },
        async findRepoWithUsage(id, workspaceId) {
            const r = await pool.query<GitRepoWithUsageRow>(
                `SELECT r.*, COUNT(l.project_id) AS project_count
                   FROM git_repos r
                   LEFT JOIN project_repo_links l ON l.repo_id = r.id
                  WHERE r.id = ? AND r.workspace_id = ?
                  GROUP BY r.id`,
                [id, workspaceId]
            );
            const row = r.rows[0];
            return row ? { ...row, project_count: Number(row.project_count) } : null;
        },
        async findRepoBySlug(workspaceId, slugRef) {
            const r = await pool.query<GitRepoRow>('SELECT * FROM git_repos WHERE workspace_id = ? AND slug_ref = ?', [
                workspaceId,
                slugRef
            ]);
            return r.rows[0] ?? null;
        },
        async countRepos(workspaceId) {
            const r = await pool.query<{ total: number }>(
                'SELECT COUNT(*) AS total FROM git_repos WHERE workspace_id = ?',
                [workspaceId]
            );
            return Number(r.rows[0]?.total ?? 0);
        },
        async createRepo({ workspaceId, provider, slugRef, credentialId, content }) {
            // Un nouveau dépôt atterrit à la fin de la liste, jamais au milieu :
            // l'ordre appartient à l'utilisateur, un ajout ne le réarrange pas.
            const posRow = await pool.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM git_repos WHERE workspace_id = ?',
                [workspaceId]
            );
            const res = await pool.query(
                `INSERT INTO git_repos (workspace_id, provider, slug_ref, credential_id, content, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [workspaceId, provider, slugRef, credentialId, content, Number(posRow.rows[0]?.next ?? 0)]
            );
            const r = await pool.query<GitRepoRow>('SELECT * FROM git_repos WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async updateRepo(id, workspaceId, { credentialId, enabled }) {
            const res = await pool.query(
                'UPDATE git_repos SET credential_id = ?, enabled = ? WHERE id = ? AND workspace_id = ?',
                [credentialId, enabled ? 1 : 0, id, workspaceId]
            );
            if (res.rowCount === 0) return null;
            return this.findRepo(id, workspaceId);
        },
        async deleteRepo(id, workspaceId) {
            // Le cache et les liaisons partent en CASCADE ; les projets liés, eux,
            // ne perdent que leur pointeur.
            const r = await pool.query('DELETE FROM git_repos WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
            return r.rowCount > 0;
        },
        async reorderRepos(workspaceId, ids) {
            // Rang = indice ; les identifiants d'un autre espace sont ignorés en
            // silence, la clause `workspace_id` s'en charge.
            for (let i = 0; i < ids.length; i++) {
                await pool.query('UPDATE git_repos SET sort_order = ? WHERE id = ? AND workspace_id = ?', [
                    i,
                    ids[i],
                    workspaceId
                ]);
            }
        },
        async listUsage(repoId, workspaceId) {
            // Les projets confidentiels ne peuvent pas être liés : filtrer sur
            // l'étage ouvert garantit que tous les titres rendus ici sont
            // lisibles sans session, plutôt que d'en masquer certains.
            const r = await pool.query<GitRepoUsageRow>(
                `SELECT p.id AS project_id, p.status, p.content
                   FROM project_repo_links l
                   JOIN projects p ON p.id = l.project_id
                  WHERE l.repo_id = ? AND l.workspace_id = ? AND p.security_tier = 'open'
                  ORDER BY p.sort_order ASC, p.id ASC`,
                [repoId, workspaceId]
            );
            return r.rows;
        },

        async findLink(projectId, workspaceId) {
            const r = await pool.query<ProjectRepoLinkRow>(
                'SELECT * FROM project_repo_links WHERE project_id = ? AND workspace_id = ?',
                [projectId, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async linkProject(projectId, workspaceId, repoId) {
            // Un projet, un dépôt : re-lier remplace, il n'ajoute pas.
            await pool.query(
                `INSERT INTO project_repo_links (project_id, workspace_id, repo_id) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE repo_id = VALUES(repo_id)`,
                [projectId, workspaceId, repoId]
            );
        },
        async unlinkProject(projectId, workspaceId) {
            const r = await pool.query('DELETE FROM project_repo_links WHERE project_id = ? AND workspace_id = ?', [
                projectId,
                workspaceId
            ]);
            return r.rowCount > 0;
        },

        async markSynced(repoId, { at, error, syncState, defaultBranch }) {
            // Plus de garde atomique sur le tier d'un projet, contrairement à ce
            // que faisait l'ancienne table : un dépôt est d'espace et toujours
            // chiffré à l'étage ouvert, donc la course « le projet passe en
            // confidentiel pendant que le service écrit » n'existe plus — elle a
            // disparu avec sa cause, pas avec sa garde.
            const sql = `UPDATE git_repos
                 SET last_sync_at = ?, last_sync_error = ?, sync_state = ?
                     ${defaultBranch === undefined ? '' : ', default_branch = ?'}
                 WHERE id = ?`;
            await pool.query(
                sql,
                defaultBranch === undefined
                    ? [at, error, syncState, repoId]
                    : [at, error, syncState, defaultBranch, repoId]
            );
        },
        async resetCache(repoId, workspaceId) {
            // La frontière d'espace d'abord : sans elle, on viderait le cache
            // d'un dépôt qui ne nous appartient pas.
            const owned = await pool.query('SELECT 1 FROM git_repos WHERE id = ? AND workspace_id = ?', [
                repoId,
                workspaceId
            ]);
            if (owned.rows.length === 0) return false;

            await pool.query('DELETE FROM git_commits WHERE repo_id = ?', [repoId]);
            await pool.query('DELETE FROM git_branches WHERE repo_id = ?', [repoId]);
            await pool.query('DELETE FROM git_releases WHERE repo_id = ?', [repoId]);
            await pool.query('DELETE FROM git_pull_requests WHERE repo_id = ?', [repoId]);

            // `sync_state` porte les ETags **et** le drapeau de backfill : le
            // vider est ce qui fait repartir la lecture de zéro plutôt que de
            // reprendre où elle s'était arrêtée. `last_sync_at` à NULL remet le
            // dépôt en tête de `listDue`, et fait réapparaître le voile de
            // progression côté interface.
            await pool.query(
                `UPDATE git_repos
                 SET sync_state = NULL, last_sync_at = NULL, last_sync_error = NULL
                 WHERE id = ? AND workspace_id = ?`,
                [repoId, workspaceId]
            );
            return true;
        },
        async listDue(limit) {
            // Jamais synchronisé d'abord (NULL trie en tête), puis le plus
            // ancien. Un dépôt sans jeton n'est pas lisible : on ne le tente pas.
            const r = await pool.query<GitRepoRow>(
                `SELECT * FROM git_repos
                 WHERE enabled = 1 AND credential_id IS NOT NULL
                 ORDER BY last_sync_at IS NOT NULL, last_sync_at ASC
                 LIMIT ?`,
                [limit]
            );
            return r.rows;
        },

        async upsertBranch({ repoId, workspaceId, nameRef, headSha, isDefault, updatedAt, content }) {
            // `ahead_count`, `behind_count` et `compared_sha` ne sont pas touchés
            // ici : ils appartiennent à `setBranchComparison`, qui seul sait sur
            // quel couple de sha ils portent. Les remettre à zéro à chaque tour
            // reviendrait à refaire la comparaison à chaque tour.
            await pool.query(
                `INSERT INTO git_branches (repo_id, workspace_id, name_ref, head_sha, is_default, updated_at, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     head_sha = VALUES(head_sha),
                     is_default = VALUES(is_default),
                     updated_at = VALUES(updated_at),
                     content = VALUES(content)`,
                [repoId, workspaceId, nameRef, headSha, isDefault ? 1 : 0, updatedAt, content]
            );
        },
        async setBranchComparison(repoId, nameRef, { ahead, behind, comparedSha }) {
            await pool.query(
                `UPDATE git_branches SET ahead_count = ?, behind_count = ?, compared_sha = ?
                 WHERE repo_id = ? AND name_ref = ?`,
                [ahead, behind, comparedSha, repoId, nameRef]
            );
        },
        async pruneBranches(repoId, keepRefs) {
            if (keepRefs.length === 0) {
                await pool.query('DELETE FROM git_branches WHERE repo_id = ?', [repoId]);
                return;
            }
            const placeholders = keepRefs.map(() => '?').join(',');
            await pool.query(`DELETE FROM git_branches WHERE repo_id = ? AND name_ref NOT IN (${placeholders})`, [
                repoId,
                ...keepRefs
            ]);
        },
        async listBranches(repoId, workspaceId) {
            const r = await pool.query<GitBranchRow>(
                `SELECT * FROM git_branches WHERE repo_id = ? AND workspace_id = ?
                 ORDER BY is_default DESC, updated_at DESC, id ASC`,
                [repoId, workspaceId]
            );
            return r.rows;
        },

        async upsertAuthor({ repoId, workspaceId, authorRef, content }) {
            // `user_id` n'est jamais touché ici : un rattachement posé à la main
            // ne doit pas être effacé par la synchronisation suivante.
            await pool.query(
                `INSERT INTO git_commit_authors (repo_id, workspace_id, author_ref, content)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE content = VALUES(content)`,
                [repoId, workspaceId, authorRef, content]
            );
        },
        async listAuthors(repoId, workspaceId) {
            const r = await pool.query<GitCommitAuthorRow>(
                'SELECT * FROM git_commit_authors WHERE repo_id = ? AND workspace_id = ?',
                [repoId, workspaceId]
            );
            return r.rows;
        },
        async setAuthorUser(repoId, workspaceId, authorRef, userId) {
            const r = await pool.query(
                'UPDATE git_commit_authors SET user_id = ? WHERE repo_id = ? AND workspace_id = ? AND author_ref = ?',
                [userId, repoId, workspaceId, authorRef]
            );
            return r.rowCount > 0;
        },

        async insertCommit({ repoId, workspaceId, sha, committedAt, authorRef, parents, content }) {
            // `IGNORE` sur la clé (repo_id, sha) : relire un commit déjà vu est le
            // cas normal d'une synchronisation incrémentale, pas une erreur.
            await pool.query(
                `INSERT IGNORE INTO git_commits
                     (repo_id, workspace_id, sha, committed_at, author_ref, parents, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [repoId, workspaceId, sha, committedAt, authorRef, JSON.stringify(parents), content]
            );
        },
        async listCommits(repoId, workspaceId, before, limit) {
            // Curseur sur le **couple de tri** `(committed_at, id)`, et non sur
            // `id` seul : les identifiants suivent l'ordre d'insertion — celui
            // où le fournisseur a rendu les commits — pas l'ordre
            // chronologique. Un `id <` sur une liste triée par date sautait donc
            // des commits, en répétait d'autres, et rendait une seconde page
            // presque vide.
            const r = await pool.query<GitCommitRow>(
                `SELECT * FROM git_commits
                 WHERE repo_id = ? AND workspace_id = ?
                   ${before === null ? '' : 'AND (committed_at < ? OR (committed_at = ? AND id < ?))'}
                 ORDER BY committed_at DESC, id DESC
                 LIMIT ?`,
                before === null
                    ? [repoId, workspaceId, limit]
                    : [repoId, workspaceId, before.committedAt, before.committedAt, before.id, limit]
            );
            return r.rows;
        },
        async listCommitPoints(repoId, workspaceId, limit) {
            // `DESC` : la borne du graphe est un filet de sécurité, jamais
            // atteint sur un dépôt ordinaire. Le jour où elle mord, mieux vaut
            // avoir écrêté l'histoire **ancienne** que la récente — c'est celle
            // qu'on regarde. L'ordre du nuage, lui, n'a aucune importance : on
            // dessine des points indépendants.
            const r = await pool.query<CommitPointRow>(
                `SELECT sha, committed_at, author_ref FROM git_commits
                 WHERE repo_id = ? AND workspace_id = ?
                 ORDER BY committed_at DESC
                 LIMIT ?`,
                [repoId, workspaceId, limit]
            );
            return r.rows.map((row) => ({ ...row, committed_at: Number(row.committed_at) }));
        },
        async commitStats(repoId, workspaceId) {
            const r = await pool.query<{ total: number; first_at: number | null; last_at: number | null }>(
                `SELECT COUNT(*) AS total, MIN(committed_at) AS first_at, MAX(committed_at) AS last_at
                 FROM git_commits WHERE repo_id = ? AND workspace_id = ?`,
                [repoId, workspaceId]
            );
            const row = r.rows[0];
            return {
                total: Number(row?.total ?? 0),
                firstAt: row?.first_at === null || row?.first_at === undefined ? null : Number(row.first_at),
                lastAt: row?.last_at === null || row?.last_at === undefined ? null : Number(row.last_at)
            };
        },
        async authorStats(repoId, workspaceId) {
            const r = await pool.query<AuthorStatRow>(
                `SELECT author_ref, COUNT(*) AS commit_count FROM git_commits
                 WHERE repo_id = ? AND workspace_id = ?
                 GROUP BY author_ref`,
                [repoId, workspaceId]
            );
            return r.rows.map((row) => ({ ...row, commit_count: Number(row.commit_count) }));
        },
        async latestCommitAt(repoId) {
            const r = await pool.query<{ last_at: number | null }>(
                'SELECT MAX(committed_at) AS last_at FROM git_commits WHERE repo_id = ?',
                [repoId]
            );
            const v = r.rows[0]?.last_at;
            return v === null || v === undefined ? null : Number(v);
        },
        async hasCommit(repoId, sha) {
            const r = await pool.query<{ one: number }>(
                'SELECT 1 AS one FROM git_commits WHERE repo_id = ? AND sha = ? LIMIT 1',
                [repoId, sha]
            );
            return r.rows.length > 0;
        },

        async upsertRelease({ repoId, workspaceId, tagRef, publishedAt, isPrerelease, content }) {
            await pool.query(
                `INSERT INTO git_releases (repo_id, workspace_id, tag_ref, published_at, is_prerelease, content)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     published_at = VALUES(published_at),
                     is_prerelease = VALUES(is_prerelease),
                     content = VALUES(content)`,
                [repoId, workspaceId, tagRef, publishedAt, isPrerelease ? 1 : 0, content]
            );
        },
        async listReleases(repoId, workspaceId) {
            const r = await pool.query<GitReleaseRow>(
                `SELECT * FROM git_releases WHERE repo_id = ? AND workspace_id = ?
                 ORDER BY published_at DESC, id DESC`,
                [repoId, workspaceId]
            );
            return r.rows;
        },

        async upsertPullRequest({
            repoId,
            workspaceId,
            number,
            state,
            authorRef,
            createdAt,
            updatedAt,
            mergedAt,
            closedAt,
            content
        }) {
            await pool.query(
                `INSERT INTO git_pull_requests
                     (repo_id, workspace_id, number, state, author_ref, created_at, updated_at, merged_at, closed_at, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     state = VALUES(state),
                     author_ref = VALUES(author_ref),
                     updated_at = VALUES(updated_at),
                     merged_at = VALUES(merged_at),
                     closed_at = VALUES(closed_at),
                     content = VALUES(content)`,
                [repoId, workspaceId, number, state, authorRef, createdAt, updatedAt, mergedAt, closedAt, content]
            );
        },
        async listPullRequests(repoId, workspaceId) {
            // Les ouvertes d'abord — ce sont elles qui demandent une action —
            // puis les plus récemment actives.
            const r = await pool.query<GitPullRequestRow>(
                `SELECT * FROM git_pull_requests WHERE repo_id = ? AND workspace_id = ?
                 ORDER BY state IN ('open', 'draft') DESC, updated_at DESC, number DESC`,
                [repoId, workspaceId]
            );
            return r.rows;
        }
    };
}
