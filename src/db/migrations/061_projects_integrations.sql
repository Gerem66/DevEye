-- Projets : intégrations externes (dépôt git et déploiement).
--
-- Reste en clair ce sur quoi le serveur trie, déduplique et agrège sans clé
-- (`sha`, `committed_at`, `author_ref`, statuts, horodatages), le reste passe
-- par `content` chiffré. Le chiffrement étant non déterministe, ce qui doit être
-- unique (nom de branche, tag) est porté par un condensé stable `*_ref`.
-- `author_ref` (16 caractères du sha256 de l'e-mail) donne une identité stable
-- sans stocker l'adresse en clair.
--
-- `project_credentials.secret_enc` est toujours sous l'étage ouvert, quel que
-- soit le tier du projet : le service de fond doit le lire sans session.

-- Identifiants d'accès aux services externes, partagés par tout l'espace : un
-- jeton GitHub sert en général à plusieurs projets.
CREATE TABLE IF NOT EXISTS project_credentials (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id INT         NOT NULL,
    -- 'github' | 'dokploy'
    provider     VARCHAR(16) NOT NULL,
    -- Étiquette lisible, choisie par l'utilisateur ; en clair, elle ne dit rien
    -- de plus que « quel jeton » et sert à les distinguer dans un sélecteur.
    label        VARCHAR(64) NOT NULL,
    -- Racine de l'instance, pour un service auto-hébergé (Dokploy). NULL = API
    -- publique du fournisseur.
    base_url     VARCHAR(255) NULL,
    -- Le secret, chiffré sous l'étage **ouvert**. Jamais renvoyé au client :
    -- les DTO ne portent qu'un booléen `hasSecret`.
    secret_enc   TEXT        NOT NULL,
    created      BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_project_credentials_workspace (workspace_id, provider),
    CONSTRAINT fk_credential_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- Le dépôt lié à un projet. Un seul par projet : au-delà, ce sont deux projets.
CREATE TABLE IF NOT EXISTS project_repos (
    project_id      INT         NOT NULL PRIMARY KEY,
    workspace_id    INT         NOT NULL,
    -- NULL = le jeton a été retiré ; la synchronisation s'arrête proprement au
    -- lieu de disparaître avec lui.
    credential_id   INT         NULL,
    provider        VARCHAR(16) NOT NULL DEFAULT 'github',
    enabled         TINYINT     NOT NULL DEFAULT 1,
    -- Branche par défaut, telle que le fournisseur la déclare.
    default_branch  VARCHAR(255) NULL,
    last_sync_at    BIGINT      NULL,
    -- Message d'échec de la dernière synchronisation, chiffré ; NULL après un
    -- succès.
    last_sync_error TEXT        NULL,
    -- État de reprise (ETags, dernier commit vu) sérialisé, chiffré : c'est ce
    -- qui rend une synchronisation incrémentale et bon marché en quota.
    sync_state      TEXT        NULL,
    -- { owner, repo } chiffré.
    content         TEXT        NOT NULL,
    created         BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    -- L'ordonnanceur ne lit que les dépôts actifs, les plus en retard d'abord.
    KEY idx_project_repos_due (enabled, last_sync_at),
    CONSTRAINT fk_repo_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_repo_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_repo_credential FOREIGN KEY (credential_id) REFERENCES project_credentials(id) ON DELETE SET NULL
);

-- Les auteurs vus dans l'historique git, et leur rattachement éventuel à un
-- membre de l'espace. Table à part plutôt qu'une colonne sur les commits : le
-- rattachement se fait une fois et vaut pour tous les commits de la personne,
-- passés comme à venir.
CREATE TABLE IF NOT EXISTS project_commit_authors (
    -- Clé de substitution, et non la paire (project_id, author_ref) : une ligne
    -- se cible par une seule colonne identifiante.
    id           INT AUTO_INCREMENT PRIMARY KEY,
    project_id   INT         NOT NULL,
    -- 16 premiers caractères du sha256 de l'adresse e-mail : identité stable,
    -- sans adresse en clair.
    author_ref   CHAR(16)    NOT NULL,
    workspace_id INT         NOT NULL,
    -- Membre auquel cet auteur git correspond ; NULL tant que personne ne l'a
    -- rattaché (le graphe lui donne alors une teinte dérivée de `author_ref`).
    user_id      INT         NULL,
    -- { name, email } chiffré.
    content      TEXT        NOT NULL,
    created      BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    UNIQUE KEY uniq_project_author (project_id, author_ref),
    CONSTRAINT fk_author_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_author_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_author_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS project_commits (
    id           BIGINT AUTO_INCREMENT PRIMARY KEY,
    project_id   INT      NOT NULL,
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
    UNIQUE KEY uniq_project_commit (project_id, sha),
    -- Le graphe lit exactement cet index : projet, puis temps.
    KEY idx_project_commits_time (project_id, committed_at),
    CONSTRAINT fk_commit_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_commit_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_branches (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    project_id   INT      NOT NULL,
    workspace_id INT      NOT NULL,
    -- Condensé du nom : porte l'unicité, que le nom chiffré ne peut pas porter.
    name_ref     CHAR(16) NOT NULL,
    head_sha     CHAR(40) NULL,
    is_default   TINYINT  NOT NULL DEFAULT 0,
    updated_at   BIGINT   NULL,
    -- { name } chiffré.
    content      TEXT     NOT NULL,
    UNIQUE KEY uniq_project_branch (project_id, name_ref),
    CONSTRAINT fk_branch_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_branch_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_releases (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    project_id   INT      NOT NULL,
    workspace_id INT      NOT NULL,
    -- Condensé du tag, même rôle que `name_ref` ci-dessus.
    tag_ref      CHAR(16) NOT NULL,
    published_at BIGINT   NOT NULL,
    is_prerelease TINYINT NOT NULL DEFAULT 0,
    -- { tag, name, body, url } chiffré.
    content      TEXT     NOT NULL,
    UNIQUE KEY uniq_project_release (project_id, tag_ref),
    -- La version « suivie » est la plus récente : cet index la donne d'un coup.
    KEY idx_project_releases_time (project_id, published_at),
    CONSTRAINT fk_release_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_release_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- La cible de déploiement d'un projet (phase suivante) : une application chez
-- un fournisseur, désignée par son identifiant externe.
CREATE TABLE IF NOT EXISTS project_deploy_targets (
    project_id    INT          NOT NULL PRIMARY KEY,
    workspace_id  INT          NOT NULL,
    credential_id INT          NULL,
    provider      VARCHAR(16)  NOT NULL DEFAULT 'dokploy',
    -- Identifiant de l'application chez le fournisseur.
    external_id   VARCHAR(128) NOT NULL,
    created       BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    -- { name } chiffré.
    content       TEXT         NOT NULL,
    CONSTRAINT fk_target_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_target_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_target_credential FOREIGN KEY (credential_id) REFERENCES project_credentials(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS project_deployments (
    id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
    project_id           INT          NOT NULL,
    workspace_id         INT          NOT NULL,
    provider             VARCHAR(16)  NOT NULL DEFAULT 'dokploy',
    -- Identifiant du déploiement chez le fournisseur, quand il en donne un.
    external_id          VARCHAR(128) NULL,
    -- 'queued' | 'running' | 'success' | 'failed'
    status               VARCHAR(16)  NOT NULL DEFAULT 'queued',
    -- Qui l'a déclenché ; NULL = tâche de fond, ou compte supprimé depuis.
    triggered_by_user_id INT          NULL,
    started_at           BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    finished_at          BIGINT       NULL,
    -- { title, description, url, logExcerpt } chiffré.
    content              TEXT         NOT NULL,
    KEY idx_project_deployments_time (project_id, started_at),
    CONSTRAINT fk_deployment_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_deployment_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_deployment_user FOREIGN KEY (triggered_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);
