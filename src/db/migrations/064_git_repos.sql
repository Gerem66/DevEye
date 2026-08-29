-- Git : le dépôt devient une entité de l'espace, le projet n'en garde qu'un
-- lien. Un dépôt partagé par deux projets était synchronisé deux fois, un dépôt
-- sans projet n'avait pas de place, et le cache suivait le `security_tier` du
-- projet. Le cache git vit désormais toujours à l'étage ouvert, sous la clé de
-- l'espace : un projet confidentiel n'a pas de dépôt.
--
-- Table rase, pas de conversion : `owner/repo` est chiffré, donc aucune requête
-- SQL ne peut en dériver le `slug_ref` qui porte l'unicité. `project_credentials`
-- est conservée (un secret ne se retrouve pas) et sert aussi Dokploy.

-- L'ancien cache, clé sur le projet. Les FK partent avec les tables.
DROP TABLE IF EXISTS project_pull_requests;
DROP TABLE IF EXISTS project_releases;
DROP TABLE IF EXISTS project_branches;
DROP TABLE IF EXISTS project_commits;
DROP TABLE IF EXISTS project_commit_authors;
DROP TABLE IF EXISTS project_repos;

-- Le dépôt, porté par l'espace.
CREATE TABLE IF NOT EXISTS git_repos (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id    INT          NOT NULL,
    -- NULL = le jeton a été retiré ; la synchronisation s'arrête proprement au
    -- lieu de disparaître avec lui.
    credential_id   INT          NULL,
    provider        VARCHAR(16)  NOT NULL DEFAULT 'github',
    -- 16 premiers caractères du sha256 de `owner/repo` en minuscules : le
    -- chiffrement étant non déterministe, `content` ne peut porter aucune
    -- contrainte d'unicité. C'est ce condensé qui rend `git.repoAdd` idempotente.
    slug_ref        CHAR(16)     NOT NULL,
    enabled         TINYINT      NOT NULL DEFAULT 1,
    -- Branche par défaut, telle que le fournisseur la déclare.
    default_branch  VARCHAR(255) NULL,
    last_sync_at    BIGINT       NULL,
    -- Message d'échec de la dernière synchronisation, chiffré ; NULL après un
    -- succès.
    last_sync_error TEXT         NULL,
    -- État de reprise (ETags, dernier commit vu) sérialisé, chiffré : c'est ce
    -- qui rend une synchronisation incrémentale et bon marché en quota.
    sync_state      TEXT         NULL,
    -- { owner, repo } chiffré, étage ouvert.
    content         TEXT         NOT NULL,
    created         BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_git_repo (workspace_id, slug_ref),
    -- L'ordonnanceur ne lit que les dépôts actifs, les plus en retard d'abord.
    KEY idx_git_repos_due (enabled, last_sync_at),
    CONSTRAINT fk_git_repo_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_git_repo_credential FOREIGN KEY (credential_id) REFERENCES project_credentials(id) ON DELETE SET NULL
);

-- La liaison projet → dépôt. `project_id` en clé primaire : un projet, un
-- dépôt, mais plusieurs projets peuvent pointer le même dépôt. Les deux FK sont
-- en CASCADE : supprimer un projet ou un dépôt ne fait tomber que la liaison.
CREATE TABLE IF NOT EXISTS project_repo_links (
    project_id   INT    NOT NULL PRIMARY KEY,
    workspace_id INT    NOT NULL,
    repo_id      INT    NOT NULL,
    created      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    -- « Combien de projets utilisent ce dépôt » se lit sur cet index seul.
    KEY idx_project_repo_links_repo (repo_id),
    CONSTRAINT fk_prl_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_prl_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_prl_repo FOREIGN KEY (repo_id) REFERENCES git_repos(id) ON DELETE CASCADE
);

-- Les auteurs vus dans l'historique, et leur rattachement éventuel à un membre.
-- Table à part plutôt qu'une colonne sur les commits : le rattachement se fait
-- une fois et vaut pour tous les commits de la personne, passés comme à venir.
CREATE TABLE IF NOT EXISTS git_commit_authors (
    -- Clé de substitution, et non la paire (repo_id, author_ref) : une ligne se
    -- cible par une seule colonne identifiante.
    id           INT AUTO_INCREMENT PRIMARY KEY,
    repo_id      INT      NOT NULL,
    -- 16 premiers caractères du sha256 de l'adresse e-mail : identité stable,
    -- sans adresse en clair.
    author_ref   CHAR(16) NOT NULL,
    workspace_id INT      NOT NULL,
    -- Membre auquel cet auteur git correspond ; NULL tant que personne ne l'a
    -- rattaché (le graphe lui donne alors une teinte dérivée de `author_ref`).
    user_id      INT      NULL,
    -- { name, email } chiffré.
    content      TEXT     NOT NULL,
    created      BIGINT   NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_git_author (repo_id, author_ref),
    CONSTRAINT fk_git_author_repo FOREIGN KEY (repo_id) REFERENCES git_repos(id) ON DELETE CASCADE,
    CONSTRAINT fk_git_author_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_git_author_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS git_commits (
    id           BIGINT AUTO_INCREMENT PRIMARY KEY,
    repo_id      INT      NOT NULL,
    workspace_id INT      NOT NULL,
    sha          CHAR(40) NOT NULL,
    committed_at BIGINT   NOT NULL,
    author_ref   CHAR(16) NOT NULL,
    -- Tableau JSON des sha parents : c'est ce qui distingue une fusion d'un
    -- commit ordinaire sans avoir à déchiffrer quoi que ce soit.
    parents      JSON     NULL,
    -- { message, authorName, authorEmail, url } chiffré.
    content      TEXT     NOT NULL,
    -- Le sha est l'identité du commit : c'est lui qui rend la synchronisation
    -- ré-entrante (un même commit relu n'est pas ré-inséré).
    UNIQUE KEY uniq_git_commit (repo_id, sha),
    -- Le graphe lit exactement cet index : dépôt, puis temps.
    KEY idx_git_commits_time (repo_id, committed_at),
    CONSTRAINT fk_git_commit_repo FOREIGN KEY (repo_id) REFERENCES git_repos(id) ON DELETE CASCADE,
    CONSTRAINT fk_git_commit_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS git_branches (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    repo_id      INT      NOT NULL,
    workspace_id INT      NOT NULL,
    -- Condensé du nom : porte l'unicité, que le nom chiffré ne peut pas porter.
    name_ref     CHAR(16) NOT NULL,
    head_sha     CHAR(40) NULL,
    -- Avance et retard sur la branche par défaut. NULL = jamais comparée — et
    -- non « zéro », qui voudrait dire « à jour » et serait une affirmation.
    ahead_count  INT      NULL,
    behind_count INT      NULL,
    -- Le couple « base..tête » sur lequel l'avance-retard a été calculée : sans
    -- lui on ne saurait pas si les compteurs valent encore, et recomparer toutes
    -- les branches à chaque tour coûterait un appel par branche pour un résultat
    -- le plus souvent identique.
    compared_sha VARCHAR(96) NULL,
    is_default   TINYINT  NOT NULL DEFAULT 0,
    updated_at   BIGINT   NULL,
    -- { name } chiffré.
    content      TEXT     NOT NULL,
    UNIQUE KEY uniq_git_branch (repo_id, name_ref),
    CONSTRAINT fk_git_branch_repo FOREIGN KEY (repo_id) REFERENCES git_repos(id) ON DELETE CASCADE,
    CONSTRAINT fk_git_branch_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS git_releases (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    repo_id       INT      NOT NULL,
    workspace_id  INT      NOT NULL,
    -- Condensé du tag, même rôle que `name_ref` ci-dessus.
    tag_ref       CHAR(16) NOT NULL,
    published_at  BIGINT   NOT NULL,
    is_prerelease TINYINT  NOT NULL DEFAULT 0,
    -- { tag, name, body, url } chiffré.
    content       TEXT     NOT NULL,
    UNIQUE KEY uniq_git_release (repo_id, tag_ref),
    -- La version « suivie » est la plus récente : cet index la donne d'un coup.
    KEY idx_git_releases_time (repo_id, published_at),
    CONSTRAINT fk_git_release_repo FOREIGN KEY (repo_id) REFERENCES git_repos(id) ON DELETE CASCADE,
    CONSTRAINT fk_git_release_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- `number` porte l'unicité : identité publique et stable d'une PR, déjà un
-- entier, pas besoin d'un condensé `*_ref`.
CREATE TABLE IF NOT EXISTS git_pull_requests (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    repo_id      INT         NOT NULL,
    workspace_id INT         NOT NULL,
    number       INT         NOT NULL,
    -- 'open' | 'draft' | 'merged' | 'closed'. « fusionnée » et « fermée » sont
    -- deux issues distinctes : GitHub les confond dans `state`, pas nous.
    state        VARCHAR(16) NOT NULL DEFAULT 'open',
    -- Condensé du login de l'auteur : même rôle que `author_ref` sur les
    -- commits — une identité stable sans identifiant en clair.
    author_ref   CHAR(16)    NULL,
    created_at   BIGINT      NOT NULL,
    updated_at   BIGINT      NOT NULL,
    merged_at    BIGINT      NULL,
    closed_at    BIGINT      NULL,
    -- { title, body, authorName, headBranch, baseBranch, url } chiffré.
    content      TEXT        NOT NULL,
    UNIQUE KEY uniq_git_pull (repo_id, number),
    -- La liste s'ouvre sur « les plus récemment actives » : cet index la donne.
    KEY idx_git_pulls_time (repo_id, updated_at),
    CONSTRAINT fk_git_pull_repo FOREIGN KEY (repo_id) REFERENCES git_repos(id) ON DELETE CASCADE,
    CONSTRAINT fk_git_pull_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
