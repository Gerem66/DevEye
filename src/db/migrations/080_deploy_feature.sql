-- Déploiement : la cible devient une entité de l'espace, le projet n'en garde
-- qu'un lien (même renversement que 064 pour les dépôts git : une pile compose
-- sert souvent deux projets). Tout vit à l'étage ouvert, sous la clé de
-- l'espace : un projet confidentiel n'a pas de déploiement.
--
-- Les données sont reprises : `external_id` est en clair et `content` était déjà
-- à l'étage ouvert. Une cible reliée à deux projets fusionne en une seule ligne.
--
-- Ré-entrant : les migrations tournent hors transaction et `_migrations` n'est
-- écrit qu'après un succès complet, donc un fichier qui s'arrête au milieu se
-- rejoue depuis le début. Chaque étape teste l'état avant d'agir.

-- 1. Les jetons, sous leur vrai nom : la table est portée par l'espace et sert
--    deux intégrations. Renommée seulement si l'ancienne est encore là ET la
--    nouvelle pas encore : un rejeu voit exactement l'inverse.
SET @rename_credentials = IF(
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_credentials') = 1
    AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_credentials') = 0,
    'RENAME TABLE project_credentials TO workspace_credentials',
    'SELECT 1'
);
PREPARE stmt FROM @rename_credentials; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. La cible, portée par l'espace.
--
-- Collation déclarée : un `CREATE TABLE` sans clause hérite du défaut de la
-- base (`utf8mb4_0900_ai_ci` sur un MySQL 8 récent), et la reprise plus bas
-- joint cette table à une ancienne en `utf8mb4_general_ci` sur `external_id`.
-- Deux collations différentes lèvent « Illegal mix of collations ».
CREATE TABLE IF NOT EXISTS deploy_targets (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id  INT          NOT NULL,
    -- NULL = le jeton a été retiré : la cible reste, indéployable, et le dit.
    credential_id INT          NULL,
    provider      VARCHAR(16)  NOT NULL DEFAULT 'dokploy',
    -- 'application' | 'compose'. Une cible sans son type est indéployable : les
    -- deux n'ont ni la même procédure de déclenchement ni la même d'historique.
    target_kind   VARCHAR(16)  NOT NULL DEFAULT 'application',
    -- Identifiant de la cible chez le fournisseur. En clair (il n'identifie
    -- personne) : l'unicité est une vraie contrainte SQL, sans condensé.
    external_id   VARCHAR(128) NOT NULL,
    -- Rang dans la liste, entièrement défini par l'utilisateur (`deploy.reorder`).
    sort_order    INT          NOT NULL DEFAULT 0,
    -- { name } chiffré, étage ouvert.
    content       TEXT         NOT NULL,
    created       BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    -- Deux fois la même application sur la même instance, c'est la même cible :
    -- c'est ce qui rend `deploy.add` idempotente.
    UNIQUE KEY uniq_deploy_target (workspace_id, credential_id, external_id),
    CONSTRAINT fk_deploy_target_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_deploy_target_credential FOREIGN KEY (credential_id) REFERENCES workspace_credentials(id) ON DELETE SET NULL
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 3. La liaison projet → cible (même forme que 067, 068, 069, 077).
--
-- `fk_pdpl_*` et non `fk_pdl_*` : InnoDB exige des noms de contrainte uniques
-- par schéma, pas par table, et `project_database_links` (068) tient déjà
-- `fk_pdl_project` et `fk_pdl_workspace`.
CREATE TABLE IF NOT EXISTS project_deploy_links (
    project_id   INT    NOT NULL,
    target_id    INT    NOT NULL,
    workspace_id INT    NOT NULL,
    created      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (project_id, target_id),
    -- « Combien de projets déploient cette cible » se lit sur cet index seul.
    KEY idx_project_deploy_links_target (target_id),
    CONSTRAINT fk_pdpl_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_pdpl_target FOREIGN KEY (target_id) REFERENCES deploy_targets(id) ON DELETE CASCADE,
    CONSTRAINT fk_pdpl_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 4. Les déploiements pendent à la cible. `provider` disparaît : il est celui
--    de la cible. `fk_deployments_*` au pluriel : `project_deployments`, encore
--    là à cet instant du fichier, tient déjà `fk_deployment_workspace`.
CREATE TABLE IF NOT EXISTS deployments (
    id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
    target_id            INT          NOT NULL,
    workspace_id         INT          NOT NULL,
    -- Identifiant du déploiement chez le fournisseur, quand il en donne un
    -- (Dokploy ne le fait pas toujours, d'où le rattachement par proximité de
    -- date en second recours).
    external_id          VARCHAR(128) NULL,
    -- 'queued' | 'running' | 'success' | 'failed'
    status               VARCHAR(16)  NOT NULL DEFAULT 'queued',
    -- Qui l'a déclenché ; NULL = tâche de fond, ou compte supprimé depuis.
    triggered_by_user_id INT          NULL,
    started_at           BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    finished_at          BIGINT       NULL,
    -- { title, description, url } chiffré, étage ouvert.
    content              TEXT         NOT NULL,
    KEY idx_deployments_time (target_id, started_at),
    -- Ce que l'ordonnanceur va chercher : les quelques déploiements en vol.
    KEY idx_deployments_status (status, started_at),
    CONSTRAINT fk_deployments_target FOREIGN KEY (target_id) REFERENCES deploy_targets(id) ON DELETE CASCADE,
    CONSTRAINT fk_deployments_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_deployments_user FOREIGN KEY (triggered_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 5. Reprise des données, seulement si l'ancienne table est encore là : sur un
--    rejeu après succès partiel, elle a pu être supprimée à l'étape 6.
SET @has_old_targets = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
                         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_deploy_targets');
SET @has_old_deployments = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
                             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_deployments');

-- `INSERT IGNORE` porte la fusion (deux projets visant la même application
-- partagent désormais une cible) et rend l'étape rejouable.
SET @copy_targets = IF(@has_old_targets = 1,
    'INSERT IGNORE INTO deploy_targets (workspace_id, credential_id, provider, target_kind, external_id, content, created)
     SELECT workspace_id, credential_id, provider, target_kind, external_id, content, created
       FROM project_deploy_targets',
    'SELECT 1'
);
PREPARE stmt FROM @copy_targets; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- La liaison se retrouve par (espace, jeton, identifiant externe). `<=>` et non
-- `=` : un jeton retiré vaut NULL. `MIN(t.id)` tranche le cas de deux cibles sans
-- jeton (MySQL admet les NULL multiples dans une clé unique).
-- `COLLATE` sur la comparaison : c'est l'ancienne table qui diverge sur une
-- installation neuve, où 061 la crée sans clause.
SET @copy_links = IF(@has_old_targets = 1,
    'INSERT IGNORE INTO project_deploy_links (project_id, target_id, workspace_id)
     SELECT o.project_id, MIN(t.id), o.workspace_id
       FROM project_deploy_targets o
       JOIN deploy_targets t
         ON t.workspace_id = o.workspace_id
        AND t.external_id = o.external_id COLLATE utf8mb4_general_ci
        AND t.credential_id <=> o.credential_id
      GROUP BY o.project_id, o.workspace_id',
    'SELECT 1'
);
PREPARE stmt FROM @copy_links; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- L'historique suit la cible de son projet. Un déploiement dont le projet
-- n'avait plus de cible part avec l'ancienne table.
-- La garde « `deployments` est vide » est indispensable : sans clé d'unicité,
-- un rejeu importerait l'historique une seconde fois.
SET @deployments_empty = (SELECT COUNT(*) = 0 FROM deployments);
SET @copy_deployments = IF(@has_old_deployments = 1 AND @deployments_empty,
    'INSERT INTO deployments
        (target_id, workspace_id, external_id, status, triggered_by_user_id, started_at, finished_at, content)
     SELECT l.target_id, d.workspace_id, d.external_id, d.status, d.triggered_by_user_id,
            d.started_at, d.finished_at, d.content
       FROM project_deployments d
       JOIN project_deploy_links l ON l.project_id = d.project_id
      ORDER BY d.id',
    'SELECT 1'
);
PREPARE stmt FROM @copy_deployments; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 6. L'ancien monde. Les FK partent avec les tables.
DROP TABLE IF EXISTS project_deployments;
DROP TABLE IF EXISTS project_deploy_targets;
