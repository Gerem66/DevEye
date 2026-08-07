import type {
    ProjectBranchRow,
    ProjectCommitAuthorRow,
    ProjectCommitRow,
    ProjectCredentialRow,
    ProjectReleaseRow,
    ProjectRepoRow
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

export interface ProjectGitRepo {
    // -- identifiants d'accès (portée : l'espace) --------------------------
    listCredentials(workspaceId: number): Promise<ProjectCredentialRow[]>;
    findCredential(id: number, workspaceId: number): Promise<ProjectCredentialRow | null>;
    createCredential(input: {
        workspaceId: number;
        provider: string;
        label: string;
        baseUrl: string | null;
        secretEnc: string;
    }): Promise<ProjectCredentialRow>;
    updateCredential(
        id: number,
        workspaceId: number,
        input: { label: string; baseUrl: string | null; secretEnc?: string }
    ): Promise<ProjectCredentialRow | null>;
    deleteCredential(id: number, workspaceId: number): Promise<boolean>;

    // -- dépôt lié ---------------------------------------------------------
    findRepo(projectId: number, workspaceId: number): Promise<ProjectRepoRow | null>;
    upsertRepo(input: {
        projectId: number;
        workspaceId: number;
        provider: string;
        credentialId: number | null;
        content: string;
    }): Promise<ProjectRepoRow>;
    deleteRepo(projectId: number, workspaceId: number): Promise<boolean>;
    setRepoEnabled(projectId: number, workspaceId: number, enabled: boolean): Promise<ProjectRepoRow | null>;
    /** Résultat d'un tour de synchronisation : succès (erreur nulle) ou échec. */
    markSynced(
        projectId: number,
        input: { at: number | null; error: string | null; syncState: string | null; defaultBranch?: string | null }
    ): Promise<void>;
    /** Les dépôts que l'ordonnanceur doit traiter, les plus en retard d'abord. */
    listDue(limit: number): Promise<ProjectRepoRow[]>;
    /**
     * Jette l'état de reprise et le dernier message d'erreur.
     *
     * Appelé à chaque bascule de tier d'un projet : ces deux colonnes sont
     * éphémères et toujours écrites à l'étage ouvert, donc elles ne se
     * convertissent pas (voir `projectRekey.ts`). Les effacer coûte une requête
     * sans ETag au tour suivant, et rien d'autre.
     */
    clearSyncState(projectId: number, workspaceId: number): Promise<void>;

    // -- cache git ---------------------------------------------------------
    upsertBranch(input: {
        projectId: number;
        workspaceId: number;
        nameRef: string;
        headSha: string | null;
        isDefault: boolean;
        updatedAt: number | null;
        content: string;
    }): Promise<void>;
    /** Retire les branches disparues du distant. */
    pruneBranches(projectId: number, keepRefs: string[]): Promise<void>;
    listBranches(projectId: number, workspaceId: number): Promise<ProjectBranchRow[]>;

    upsertAuthor(input: { projectId: number; workspaceId: number; authorRef: string; content: string }): Promise<void>;
    listAuthors(projectId: number, workspaceId: number): Promise<ProjectCommitAuthorRow[]>;
    setAuthorUser(projectId: number, workspaceId: number, authorRef: string, userId: number | null): Promise<boolean>;

    insertCommit(input: {
        projectId: number;
        workspaceId: number;
        sha: string;
        committedAt: number;
        authorRef: string;
        parents: string[];
        content: string;
    }): Promise<void>;
    listCommits(
        projectId: number,
        workspaceId: number,
        before: number | null,
        limit: number
    ): Promise<ProjectCommitRow[]>;
    /** Tous les points du graphe, colonnes claires uniquement. */
    listCommitPoints(projectId: number, workspaceId: number, limit: number): Promise<CommitPointRow[]>;
    commitStats(
        projectId: number,
        workspaceId: number
    ): Promise<{ total: number; firstAt: number | null; lastAt: number | null }>;
    authorStats(projectId: number, workspaceId: number): Promise<AuthorStatRow[]>;
    /** Horodatage du commit le plus récent connu, pour reprendre la lecture. */
    latestCommitAt(projectId: number): Promise<number | null>;

    upsertRelease(input: {
        projectId: number;
        workspaceId: number;
        tagRef: string;
        publishedAt: number;
        isPrerelease: boolean;
        content: string;
    }): Promise<void>;
    listReleases(projectId: number, workspaceId: number): Promise<ProjectReleaseRow[]>;
}

export function projectGitRepo(pool: Q): ProjectGitRepo {
    return {
        async listCredentials(workspaceId) {
            const r = await pool.query<ProjectCredentialRow>(
                'SELECT * FROM project_credentials WHERE workspace_id = ? ORDER BY provider ASC, label ASC',
                [workspaceId]
            );
            return r.rows;
        },
        async findCredential(id, workspaceId) {
            const r = await pool.query<ProjectCredentialRow>(
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
            const r = await pool.query<ProjectCredentialRow>('SELECT * FROM project_credentials WHERE id = ?', [
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

        async findRepo(projectId, workspaceId) {
            const r = await pool.query<ProjectRepoRow>(
                'SELECT * FROM project_repos WHERE project_id = ? AND workspace_id = ?',
                [projectId, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async upsertRepo({ projectId, workspaceId, provider, credentialId, content }) {
            // Re-lier remet l'état de reprise à zéro : le cache décrit l'ancien
            // dépôt, le garder ferait croire à un historique qui n'est plus.
            await pool.query(
                `INSERT INTO project_repos (project_id, workspace_id, provider, credential_id, content)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     provider = VALUES(provider),
                     credential_id = VALUES(credential_id),
                     content = VALUES(content),
                     sync_state = NULL,
                     last_sync_at = NULL,
                     last_sync_error = NULL`,
                [projectId, workspaceId, provider, credentialId, content]
            );
            const r = await pool.query<ProjectRepoRow>('SELECT * FROM project_repos WHERE project_id = ?', [projectId]);
            return r.rows[0];
        },
        async deleteRepo(projectId, workspaceId) {
            // Le cache local part avec le lien : il ne décrit plus rien.
            await pool.query('DELETE FROM project_commits WHERE project_id = ?', [projectId]);
            await pool.query('DELETE FROM project_branches WHERE project_id = ?', [projectId]);
            await pool.query('DELETE FROM project_releases WHERE project_id = ?', [projectId]);
            await pool.query('DELETE FROM project_commit_authors WHERE project_id = ?', [projectId]);
            const r = await pool.query('DELETE FROM project_repos WHERE project_id = ? AND workspace_id = ?', [
                projectId,
                workspaceId
            ]);
            return r.rowCount > 0;
        },
        async setRepoEnabled(projectId, workspaceId, enabled) {
            const res = await pool.query(
                'UPDATE project_repos SET enabled = ? WHERE project_id = ? AND workspace_id = ?',
                [enabled ? 1 : 0, projectId, workspaceId]
            );
            if (res.rowCount === 0) return null;
            return this.findRepo(projectId, workspaceId);
        },
        async markSynced(projectId, { at, error, syncState, defaultBranch }) {
            // ⚠️ Garde atomique sur le tier, et pas seulement dans `listDue`.
            //
            // Le service de fond chiffre **toujours** à l'étage ouvert. Entre le
            // moment où il sélectionne un dépôt et celui où il écrit son
            // résultat, le projet peut être passé en confidentiel : l'écriture
            // déposerait alors un blob chiffré sous la mauvaise clé, et la
            // conversion de tier suivante échouerait définitivement sur une
            // ligne illisible. Course observée en test, pas théorique.
            //
            // La condition vit dans le SQL plutôt que dans le service pour la
            // même raison que celle de `listDue` : ainsi elle ne peut être ni
            // contournée par un nouvel appelant, ni perdue dans une fenêtre
            // entre la vérification et l'écriture.
            const sql = `UPDATE project_repos r
                 JOIN projects p ON p.id = r.project_id AND p.security_tier = 'open'
                 SET r.last_sync_at = ?, r.last_sync_error = ?, r.sync_state = ?
                     ${defaultBranch === undefined ? '' : ', r.default_branch = ?'}
                 WHERE r.project_id = ?`;
            await pool.query(
                sql,
                defaultBranch === undefined
                    ? [at, error, syncState, projectId]
                    : [at, error, syncState, defaultBranch, projectId]
            );
        },
        async clearSyncState(projectId, workspaceId) {
            await pool.query(
                'UPDATE project_repos SET sync_state = NULL, last_sync_error = NULL WHERE project_id = ? AND workspace_id = ?',
                [projectId, workspaceId]
            );
        },
        async listDue(limit) {
            // Jamais synchronisé d'abord (NULL trie en tête), puis le plus
            // ancien. Seuls les dépôts actifs de projets **ouverts** : un projet
            // confidentiel n'est pas lisible sans session.
            const r = await pool.query<ProjectRepoRow>(
                `SELECT r.* FROM project_repos r
                 JOIN projects p ON p.id = r.project_id
                 WHERE r.enabled = 1
                   AND r.credential_id IS NOT NULL
                   AND p.security_tier = 'open'
                   AND p.archived_at IS NULL
                 ORDER BY r.last_sync_at IS NOT NULL, r.last_sync_at ASC
                 LIMIT ?`,
                [limit]
            );
            return r.rows;
        },

        async upsertBranch({ projectId, workspaceId, nameRef, headSha, isDefault, updatedAt, content }) {
            await pool.query(
                `INSERT INTO project_branches (project_id, workspace_id, name_ref, head_sha, is_default, updated_at, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     head_sha = VALUES(head_sha),
                     is_default = VALUES(is_default),
                     updated_at = VALUES(updated_at),
                     content = VALUES(content)`,
                [projectId, workspaceId, nameRef, headSha, isDefault ? 1 : 0, updatedAt, content]
            );
        },
        async pruneBranches(projectId, keepRefs) {
            if (keepRefs.length === 0) {
                await pool.query('DELETE FROM project_branches WHERE project_id = ?', [projectId]);
                return;
            }
            const placeholders = keepRefs.map(() => '?').join(',');
            await pool.query(
                `DELETE FROM project_branches WHERE project_id = ? AND name_ref NOT IN (${placeholders})`,
                [projectId, ...keepRefs]
            );
        },
        async listBranches(projectId, workspaceId) {
            const r = await pool.query<ProjectBranchRow>(
                `SELECT * FROM project_branches WHERE project_id = ? AND workspace_id = ?
                 ORDER BY is_default DESC, updated_at DESC, id ASC`,
                [projectId, workspaceId]
            );
            return r.rows;
        },

        async upsertAuthor({ projectId, workspaceId, authorRef, content }) {
            // `user_id` n'est jamais touché ici : un rattachement posé à la main
            // ne doit pas être effacé par la synchronisation suivante.
            await pool.query(
                `INSERT INTO project_commit_authors (project_id, workspace_id, author_ref, content)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE content = VALUES(content)`,
                [projectId, workspaceId, authorRef, content]
            );
        },
        async listAuthors(projectId, workspaceId) {
            const r = await pool.query<ProjectCommitAuthorRow>(
                'SELECT * FROM project_commit_authors WHERE project_id = ? AND workspace_id = ?',
                [projectId, workspaceId]
            );
            return r.rows;
        },
        async setAuthorUser(projectId, workspaceId, authorRef, userId) {
            const r = await pool.query(
                'UPDATE project_commit_authors SET user_id = ? WHERE project_id = ? AND workspace_id = ? AND author_ref = ?',
                [userId, projectId, workspaceId, authorRef]
            );
            return r.rowCount > 0;
        },

        async insertCommit({ projectId, workspaceId, sha, committedAt, authorRef, parents, content }) {
            // `IGNORE` sur la clé (project_id, sha) : relire un commit déjà vu
            // est le cas normal d'une synchronisation incrémentale, pas une
            // erreur.
            await pool.query(
                `INSERT IGNORE INTO project_commits
                     (project_id, workspace_id, sha, committed_at, author_ref, parents, content)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [projectId, workspaceId, sha, committedAt, authorRef, JSON.stringify(parents), content]
            );
        },
        async listCommits(projectId, workspaceId, before, limit) {
            const r = await pool.query<ProjectCommitRow>(
                `SELECT * FROM project_commits
                 WHERE project_id = ? AND workspace_id = ?${before === null ? '' : ' AND id < ?'}
                 ORDER BY committed_at DESC, id DESC
                 LIMIT ?`,
                before === null ? [projectId, workspaceId, limit] : [projectId, workspaceId, before, limit]
            );
            return r.rows;
        },
        async listCommitPoints(projectId, workspaceId, limit) {
            const r = await pool.query<CommitPointRow>(
                `SELECT sha, committed_at, author_ref FROM project_commits
                 WHERE project_id = ? AND workspace_id = ?
                 ORDER BY committed_at ASC
                 LIMIT ?`,
                [projectId, workspaceId, limit]
            );
            return r.rows.map((row) => ({ ...row, committed_at: Number(row.committed_at) }));
        },
        async commitStats(projectId, workspaceId) {
            const r = await pool.query<{ total: number; first_at: number | null; last_at: number | null }>(
                `SELECT COUNT(*) AS total, MIN(committed_at) AS first_at, MAX(committed_at) AS last_at
                 FROM project_commits WHERE project_id = ? AND workspace_id = ?`,
                [projectId, workspaceId]
            );
            const row = r.rows[0];
            return {
                total: Number(row?.total ?? 0),
                firstAt: row?.first_at === null || row?.first_at === undefined ? null : Number(row.first_at),
                lastAt: row?.last_at === null || row?.last_at === undefined ? null : Number(row.last_at)
            };
        },
        async authorStats(projectId, workspaceId) {
            const r = await pool.query<AuthorStatRow>(
                `SELECT author_ref, COUNT(*) AS commit_count FROM project_commits
                 WHERE project_id = ? AND workspace_id = ?
                 GROUP BY author_ref`,
                [projectId, workspaceId]
            );
            return r.rows.map((row) => ({ ...row, commit_count: Number(row.commit_count) }));
        },
        async latestCommitAt(projectId) {
            const r = await pool.query<{ last_at: number | null }>(
                'SELECT MAX(committed_at) AS last_at FROM project_commits WHERE project_id = ?',
                [projectId]
            );
            const v = r.rows[0]?.last_at;
            return v === null || v === undefined ? null : Number(v);
        },

        async upsertRelease({ projectId, workspaceId, tagRef, publishedAt, isPrerelease, content }) {
            await pool.query(
                `INSERT INTO project_releases (project_id, workspace_id, tag_ref, published_at, is_prerelease, content)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     published_at = VALUES(published_at),
                     is_prerelease = VALUES(is_prerelease),
                     content = VALUES(content)`,
                [projectId, workspaceId, tagRef, publishedAt, isPrerelease ? 1 : 0, content]
            );
        },
        async listReleases(projectId, workspaceId) {
            const r = await pool.query<ProjectReleaseRow>(
                `SELECT * FROM project_releases WHERE project_id = ? AND workspace_id = ?
                 ORDER BY published_at DESC, id DESC`,
                [projectId, workspaceId]
            );
            return r.rows;
        }
    };
}
