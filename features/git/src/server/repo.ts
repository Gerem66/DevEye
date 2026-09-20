import type {
    GitBranchRow,
    GitCommitAuthorRow,
    GitCommitRow,
    GitCredentialRow,
    GitPullRequestRow,
    GitReleaseRow,
    GitRepoRow
} from '../contracts/domain';
import type { SdkQueryable } from '@deveye/types/sdk/server';

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

/**
 * Les dépôts git de l'espace, leurs jetons, et le cache de ce qu'on y a lu. Les
 * liaisons vers les projets appartiennent à Projets, dont le module ne lit aucune
 * table : le compte et la liste des projets viennent de son contrat.
 */
export interface GitRepo {
    listRepos(workspaceId: number): Promise<GitRepoRow[]>;
    /** Comme `listRepos`, plus les dépôts projetés vers cet espace. */
    listVisibleRepos(workspaceId: number): Promise<GitRepoRow[]>;
    findRepo(id: number, workspaceId: number): Promise<GitRepoRow | null>;
    /** Comme `findRepo`, mais accepte aussi un dépôt projeté vers cet espace. */
    findVisibleRepo(id: number, workspaceId: number): Promise<GitRepoRow | null>;
    /** L'unicité d'un dépôt dans l'espace, ce que `content` chiffré ne peut porter. */
    findRepoBySlug(workspaceId: number, slugRef: string): Promise<GitRepoRow | null>;
    countRepos(workspaceId: number): Promise<number>;
    countReposInWorkspaces(workspaceIds: readonly number[]): Promise<number>;
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
     * Range les dépôts de l'espace : `ids` est la liste complète, rang = indice. Ne
     * touche ni jeton ni état de synchronisation, un glisser-déposer ne devant pas
     * relancer une lecture chez le fournisseur.
     */
    reorderRepos(workspaceId: number, ids: number[]): Promise<void>;

    /**
     * Les jetons GitHub de l'espace, chiffrés à l'étage ouvert (la synchronisation
     * tourne sans session). Le secret ne sort que par la ligne brute, que seule la
     * couche feature manipule ; le DTO n'en porte qu'un booléen.
     */
    listCredentials(workspaceId: number): Promise<GitCredentialRow[]>;
    findCredential(id: number, workspaceId: number): Promise<GitCredentialRow | null>;
    createCredential(input: { workspaceId: number; label: string; secretEnc: string }): Promise<GitCredentialRow>;
    updateCredential(
        id: number,
        workspaceId: number,
        /** `secretEnc` absent = on garde le secret en place. */
        input: { label: string; secretEnc?: string }
    ): Promise<GitCredentialRow | null>;
    /**
     * Retire un jeton. Les dépôts qui s'en servaient restent, sans jeton : leur
     * synchronisation s'arrête en le disant, plutôt que de disparaître avec l'accès.
     */
    removeCredential(id: number, workspaceId: number): Promise<boolean>;
    /**
     * Combien de dépôts s'appuient sur chaque jeton de l'espace : ce chiffre dit à
     * l'écran ce qu'une suppression va couper, avant de cliquer.
     */
    countCredentialUses(workspaceId: number): Promise<Map<number, number>>;

    /** Résultat d'un tour de synchronisation : succès (erreur nulle) ou échec. */
    markSynced(
        repoId: number,
        input: { at: number | null; error: string | null; syncState: string | null; defaultBranch?: string | null }
    ): Promise<void>;
    /** Les dépôts que l'ordonnanceur doit traiter, les plus en retard d'abord. */
    listDue(limit: number): Promise<GitRepoRow[]>;
    /**
     * Jette le cache d'un dépôt pour qu'il soit relu entièrement. Les auteurs sont
     * épargnés : leur rattachement à un membre est fait à la main et rien ne
     * permettrait de le reconstituer.
     */
    resetCache(repoId: number, workspaceId: number): Promise<boolean>;

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
     * Inscrit l'avance-retard d'une branche, avec le couple de sha qui l'a produit :
     * c'est lui qui dira, au tour suivant, si le calcul tient encore.
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
     * Ce commit est-il déjà en cache ? Sert à sauter les branches qui n'ont pas
     * bougé : connaître la tête d'une branche, c'est connaître tout ce qu'elle
     * porte, ce qui ramène le balayage à zéro requête en régime établi.
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

export function createRepo(q: SdkQueryable): GitRepo {
    async function findRepo(id: number, workspaceId: number): Promise<GitRepoRow | null> {
        const rows = await q.query<GitRepoRow>('SELECT * FROM git_repos WHERE id = ? AND workspace_id = ?', [
            id,
            workspaceId
        ]);
        return rows[0] ?? null;
    }

    async function findCredential(id: number, workspaceId: number): Promise<GitCredentialRow | null> {
        const rows = await q.query<GitCredentialRow>(
            'SELECT * FROM ft_git_credentials WHERE id = ? AND workspace_id = ?',
            [id, workspaceId]
        );
        return rows[0] ?? null;
    }

    return {
        async listRepos(workspaceId) {
            return q.query<GitRepoRow>(
                'SELECT * FROM git_repos WHERE workspace_id = ? ORDER BY sort_order ASC, id ASC',
                [workspaceId]
            );
        },
        async listVisibleRepos(workspaceId) {
            // `sort_order` appartient à l'espace d'origine : un dépôt projeté se
            // range après les locaux, par identifiant.
            return q.query<GitRepoRow>(
                `SELECT r.* FROM git_repos r WHERE r.workspace_id = ?
                 UNION
                 SELECT r.* FROM git_repos r
                   JOIN item_shares sh
                     ON sh.feature = 'git' AND sh.item_id = r.id AND sh.home_workspace_id = r.workspace_id
                  WHERE sh.workspace_id = ?
                  ORDER BY sort_order ASC, id ASC`,
                [workspaceId, workspaceId]
            );
        },
        findRepo,
        async findVisibleRepo(id, workspaceId) {
            const rows = await q.query<GitRepoRow>(
                `SELECT r.* FROM git_repos r
                  WHERE r.id = ?
                    AND (r.workspace_id = ?
                         OR EXISTS (SELECT 1 FROM item_shares sh
                                     WHERE sh.feature = 'git' AND sh.item_id = r.id
                                       AND sh.home_workspace_id = r.workspace_id
                                       AND sh.workspace_id = ?))`,
                [id, workspaceId, workspaceId]
            );
            return rows[0] ?? null;
        },
        async findRepoBySlug(workspaceId, slugRef) {
            const rows = await q.query<GitRepoRow>('SELECT * FROM git_repos WHERE workspace_id = ? AND slug_ref = ?', [
                workspaceId,
                slugRef
            ]);
            return rows[0] ?? null;
        },
        async countReposInWorkspaces(workspaceIds) {
            if (workspaceIds.length === 0) return 0;
            const rows = await q.query<{ total: number }>(
                'SELECT COUNT(*) AS total FROM git_repos WHERE workspace_id IN (?)',
                [[...workspaceIds]]
            );
            return Number(rows[0]?.total ?? 0);
        },
        async countRepos(workspaceId) {
            const rows = await q.query<{ total: number }>(
                'SELECT COUNT(*) AS total FROM git_repos WHERE workspace_id = ?',
                [workspaceId]
            );
            return Number(rows[0]?.total ?? 0);
        },
        async createRepo({ workspaceId, provider, slugRef, credentialId, content }) {
            // Un nouveau dépôt atterrit à la fin de la liste, jamais au milieu :
            // l'ordre appartient à l'utilisateur, un ajout ne le réarrange pas.
            const posRows = await q.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM git_repos WHERE workspace_id = ?',
                [workspaceId]
            );
            const res = await q.execute(
                `INSERT INTO git_repos (workspace_id, provider, slug_ref, credential_id, content, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [workspaceId, provider, slugRef, credentialId, content, Number(posRows[0]?.next ?? 0)]
            );
            const rows = await q.query<GitRepoRow>('SELECT * FROM git_repos WHERE id = ?', [res.insertId]);
            return rows[0];
        },
        async updateRepo(id, workspaceId, { credentialId, enabled }) {
            const res = await q.execute(
                'UPDATE git_repos SET credential_id = ?, enabled = ? WHERE id = ? AND workspace_id = ?',
                [credentialId, enabled ? 1 : 0, id, workspaceId]
            );
            if (res.affectedRows === 0) return null;
            return findRepo(id, workspaceId);
        },
        async deleteRepo(id, workspaceId) {
            // Le cache et les liaisons partent en CASCADE ; les projets liés, eux,
            // ne perdent que leur pointeur.
            const res = await q.execute('DELETE FROM git_repos WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
            return res.affectedRows > 0;
        },
        async reorderRepos(workspaceId, ids) {
            // Rang = indice ; les identifiants d'un autre espace sont ignorés en
            // silence, la clause `workspace_id` s'en charge.
            for (let i = 0; i < ids.length; i++) {
                await q.execute('UPDATE git_repos SET sort_order = ? WHERE id = ? AND workspace_id = ?', [
                    i,
                    ids[i],
                    workspaceId
                ]);
            }
        },

        async listCredentials(workspaceId) {
            return q.query<GitCredentialRow>(
                'SELECT * FROM ft_git_credentials WHERE workspace_id = ? ORDER BY label ASC',
                [workspaceId]
            );
        },
        findCredential,
        async createCredential({ workspaceId, label, secretEnc }) {
            const res = await q.execute(
                'INSERT INTO ft_git_credentials (workspace_id, label, secret_enc) VALUES (?, ?, ?)',
                [workspaceId, label, secretEnc]
            );
            const rows = await q.query<GitCredentialRow>('SELECT * FROM ft_git_credentials WHERE id = ?', [
                res.insertId
            ]);
            return rows[0];
        },
        async updateCredential(id, workspaceId, { label, secretEnc }) {
            // Secret absent = on garde celui en place : le client ne le reçoit
            // jamais, il ne peut donc pas le renvoyer inchangé.
            const res = secretEnc
                ? await q.execute(
                      'UPDATE ft_git_credentials SET label = ?, secret_enc = ? WHERE id = ? AND workspace_id = ?',
                      [label, secretEnc, id, workspaceId]
                  )
                : await q.execute('UPDATE ft_git_credentials SET label = ? WHERE id = ? AND workspace_id = ?', [
                      label,
                      id,
                      workspaceId
                  ]);
            if (res.affectedRows === 0) return null;
            return findCredential(id, workspaceId);
        },
        async removeCredential(id, workspaceId) {
            // Le ménage explicite qui remplace la clé étrangère : InnoDB revalidait
            // la ligne mise à NULL contre un parent que la même cascade supprimait,
            // et la suppression d'un espace échouait dessus. Les dépôts du jeton
            // passent donc à NULL avant que la ligne ne parte.
            await q.execute('UPDATE git_repos SET credential_id = NULL WHERE credential_id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            const res = await q.execute('DELETE FROM ft_git_credentials WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async countCredentialUses(workspaceId) {
            const rows = await q.query<{ credential_id: number; uses: number }>(
                `SELECT credential_id, COUNT(*) AS uses FROM git_repos
                  WHERE workspace_id = ? AND credential_id IS NOT NULL
                  GROUP BY credential_id`,
                [workspaceId]
            );
            return new Map(rows.map((row) => [Number(row.credential_id), Number(row.uses)]));
        },

        async markSynced(repoId, { at, error, syncState, defaultBranch }) {
            // Aucune garde sur le palier d'un projet : un dépôt est d'espace et
            // toujours chiffré à l'étage ouvert, la course « le projet passe en
            // confidentiel pendant que le service écrit » n'existe pas.
            const sql = `UPDATE git_repos
                 SET last_sync_at = ?, last_sync_error = ?, sync_state = ?
                     ${defaultBranch === undefined ? '' : ', default_branch = ?'}
                 WHERE id = ?`;
            await q.execute(
                sql,
                defaultBranch === undefined
                    ? [at, error, syncState, repoId]
                    : [at, error, syncState, defaultBranch, repoId]
            );
        },
        async resetCache(repoId, workspaceId) {
            // La frontière d'espace d'abord : sans elle, on viderait le cache
            // d'un dépôt qui ne nous appartient pas.
            const owned = await q.query<{ one: number }>(
                'SELECT 1 AS one FROM git_repos WHERE id = ? AND workspace_id = ?',
                [repoId, workspaceId]
            );
            if (owned.length === 0) return false;

            await q.execute('DELETE FROM git_commits WHERE repo_id = ?', [repoId]);
            await q.execute('DELETE FROM git_branches WHERE repo_id = ?', [repoId]);
            await q.execute('DELETE FROM git_releases WHERE repo_id = ?', [repoId]);
            await q.execute('DELETE FROM git_pull_requests WHERE repo_id = ?', [repoId]);

            // `sync_state` porte les ETags et le drapeau de backfill : le vider fait
            // repartir la lecture de zéro. `last_sync_at` à NULL remet le dépôt en
            // tête de `listDue` et fait réapparaître le voile de progression.
            await q.execute(
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
            return q.query<GitRepoRow>(
                `SELECT * FROM git_repos
                 WHERE enabled = 1 AND credential_id IS NOT NULL
                 ORDER BY last_sync_at IS NOT NULL, last_sync_at ASC
                 LIMIT ?`,
                [limit]
            );
        },

        async upsertBranch({ repoId, workspaceId, nameRef, headSha, isDefault, updatedAt, content }) {
            // `ahead_count`, `behind_count` et `compared_sha` appartiennent à
            // `setBranchComparison`, seul à savoir sur quel couple de sha ils
            // portent : les toucher ici referait la comparaison à chaque tour.
            await q.execute(
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
            await q.execute(
                `UPDATE git_branches SET ahead_count = ?, behind_count = ?, compared_sha = ?
                 WHERE repo_id = ? AND name_ref = ?`,
                [ahead, behind, comparedSha, repoId, nameRef]
            );
        },
        async pruneBranches(repoId, keepRefs) {
            if (keepRefs.length === 0) {
                await q.execute('DELETE FROM git_branches WHERE repo_id = ?', [repoId]);
                return;
            }
            const placeholders = keepRefs.map(() => '?').join(',');
            await q.execute(`DELETE FROM git_branches WHERE repo_id = ? AND name_ref NOT IN (${placeholders})`, [
                repoId,
                ...keepRefs
            ]);
        },
        async listBranches(repoId, workspaceId) {
            return q.query<GitBranchRow>(
                `SELECT * FROM git_branches WHERE repo_id = ? AND workspace_id = ?
                 ORDER BY is_default DESC, updated_at DESC, id ASC`,
                [repoId, workspaceId]
            );
        },

        async upsertAuthor({ repoId, workspaceId, authorRef, content }) {
            // `user_id` n'est jamais touché ici : un rattachement posé à la main
            // ne doit pas être effacé par la synchronisation suivante.
            await q.execute(
                `INSERT INTO git_commit_authors (repo_id, workspace_id, author_ref, content)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE content = VALUES(content)`,
                [repoId, workspaceId, authorRef, content]
            );
        },
        async listAuthors(repoId, workspaceId) {
            return q.query<GitCommitAuthorRow>(
                'SELECT * FROM git_commit_authors WHERE repo_id = ? AND workspace_id = ?',
                [repoId, workspaceId]
            );
        },
        async setAuthorUser(repoId, workspaceId, authorRef, userId) {
            const res = await q.execute(
                'UPDATE git_commit_authors SET user_id = ? WHERE repo_id = ? AND workspace_id = ? AND author_ref = ?',
                [userId, repoId, workspaceId, authorRef]
            );
            return res.affectedRows > 0;
        },

        async insertCommit({ repoId, workspaceId, sha, committedAt, authorRef, parents, content }) {
            // `IGNORE` sur la clé (repo_id, sha) : relire un commit déjà vu est le
            // cas normal d'une synchronisation incrémentale, pas une erreur.
            await q.execute(
                `INSERT IGNORE INTO git_commits
                     (repo_id, workspace_id, sha, committed_at, author_ref, parents, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [repoId, workspaceId, sha, committedAt, authorRef, JSON.stringify(parents), content]
            );
        },
        async listCommits(repoId, workspaceId, before, limit) {
            // Curseur sur le couple de tri `(committed_at, id)` et non sur `id`
            // seul : les identifiants suivent l'ordre où le fournisseur a rendu les
            // commits, pas l'ordre chronologique, et un `id <` sauterait des
            // commits tout en en répétant d'autres.
            return q.query<GitCommitRow>(
                `SELECT * FROM git_commits
                 WHERE repo_id = ? AND workspace_id = ?
                   ${before === null ? '' : 'AND (committed_at < ? OR (committed_at = ? AND id < ?))'}
                 ORDER BY committed_at DESC, id DESC
                 LIMIT ?`,
                before === null
                    ? [repoId, workspaceId, limit]
                    : [repoId, workspaceId, before.committedAt, before.committedAt, before.id, limit]
            );
        },
        async listCommitPoints(repoId, workspaceId, limit) {
            // `DESC` : le jour où la borne du graphe mord, mieux vaut avoir écrêté
            // l'histoire ancienne que la récente. L'ordre du nuage lui-même n'a
            // aucune importance, les points sont indépendants.
            const rows = await q.query<CommitPointRow>(
                `SELECT sha, committed_at, author_ref FROM git_commits
                 WHERE repo_id = ? AND workspace_id = ?
                 ORDER BY committed_at DESC
                 LIMIT ?`,
                [repoId, workspaceId, limit]
            );
            return rows.map((row) => ({ ...row, committed_at: Number(row.committed_at) }));
        },
        async commitStats(repoId, workspaceId) {
            const rows = await q.query<{ total: number; first_at: number | null; last_at: number | null }>(
                `SELECT COUNT(*) AS total, MIN(committed_at) AS first_at, MAX(committed_at) AS last_at
                 FROM git_commits WHERE repo_id = ? AND workspace_id = ?`,
                [repoId, workspaceId]
            );
            const row = rows[0];
            return {
                total: Number(row?.total ?? 0),
                firstAt: row?.first_at === null || row?.first_at === undefined ? null : Number(row.first_at),
                lastAt: row?.last_at === null || row?.last_at === undefined ? null : Number(row.last_at)
            };
        },
        async authorStats(repoId, workspaceId) {
            const rows = await q.query<AuthorStatRow>(
                `SELECT author_ref, COUNT(*) AS commit_count FROM git_commits
                 WHERE repo_id = ? AND workspace_id = ?
                 GROUP BY author_ref`,
                [repoId, workspaceId]
            );
            return rows.map((row) => ({ ...row, commit_count: Number(row.commit_count) }));
        },
        async latestCommitAt(repoId) {
            const rows = await q.query<{ last_at: number | null }>(
                'SELECT MAX(committed_at) AS last_at FROM git_commits WHERE repo_id = ?',
                [repoId]
            );
            const v = rows[0]?.last_at;
            return v === null || v === undefined ? null : Number(v);
        },
        async hasCommit(repoId, sha) {
            const rows = await q.query<{ one: number }>(
                'SELECT 1 AS one FROM git_commits WHERE repo_id = ? AND sha = ? LIMIT 1',
                [repoId, sha]
            );
            return rows.length > 0;
        },

        async upsertRelease({ repoId, workspaceId, tagRef, publishedAt, isPrerelease, content }) {
            await q.execute(
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
            return q.query<GitReleaseRow>(
                `SELECT * FROM git_releases WHERE repo_id = ? AND workspace_id = ?
                 ORDER BY published_at DESC, id DESC`,
                [repoId, workspaceId]
            );
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
            await q.execute(
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
            // Les ouvertes d'abord, ce sont elles qui demandent une action, puis les
            // plus récemment actives.
            return q.query<GitPullRequestRow>(
                `SELECT * FROM git_pull_requests WHERE repo_id = ? AND workspace_id = ?
                 ORDER BY state IN ('open', 'draft') DESC, updated_at DESC, number DESC`,
                [repoId, workspaceId]
            );
        }
    };
}
