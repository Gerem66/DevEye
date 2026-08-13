-- Déploiement : la cible devient une entité de l'espace, le projet n'en garde
-- qu'un lien. Et les jetons cessent de s'appeler « de projet ».
--
-- Même renversement que la migration `064` pour les dépôts git, et pour les
-- mêmes raisons — c'était le dernier module resté une propriété d'un projet :
--
--   1. **Une pile compose sert souvent deux projets** (un client, un serveur).
--      `project_deploy_targets` étant clé sur `project_id`, le second ne pouvait
--      ni la voir ni la déclencher : il fallait la redéclarer, avec sa clé.
--   2. **Une application qu'on veut seulement suivre**, sans projet autour,
--      n'avait pas de place.
--   3. Le contenu suivait le `security_tier` du projet, ce qui n'a aucun sens
--      pour une donnée que plusieurs projets se partagent — et obligeait
--      `updateDeployment` à une garde atomique contre la course « le projet
--      passe en gardé pendant que le service de fond écrit ».
--
-- Tout ce qui suit vit désormais **toujours à l'étage ouvert**, sous la clé de
-- l'espace. C'est ce qui fait disparaître le point 3 avec sa cause. Corollaire
-- assumé, identique à celui des dépôts : un projet confidentiel n'a pas de
-- déploiement.
--
-- ⚠️ Les données sont **reprises**, contrairement à `064` qui avait dû faire
-- table rase. Rien ici ne porte de condensé dérivé d'un champ chiffré :
-- `external_id` est en clair, et `content` (le seul blob) ne change pas de clé —
-- il était déjà à l'étage ouvert, faute de quoi un projet confidentiel aurait pu
-- avoir une cible, ce que le serveur a toujours refusé. Une cible reliée à deux
-- projets fusionne donc en une seule ligne, ce qui est précisément le but.
--
-- ⚠️⚠️ **Ce fichier est ré-entrant, et il a fallu le rendre tel après coup.**
-- Les migrations tournent au démarrage, **hors transaction**, et `_migrations`
-- n'est écrit qu'après un succès complet : un fichier qui s'arrête au milieu
-- laisse la base à mi-chemin et **se rejoue depuis le début** au démarrage
-- suivant. C'est arrivé ici — un nom de clé étrangère déjà pris (voir plus bas)
-- a fait échouer la troisième instruction, et la reprise butait alors sur un
-- `RENAME TABLE` dont la source n'existait plus. Chaque étape teste donc l'état
-- avant d'agir, par `INFORMATION_SCHEMA` + SQL dynamique (le motif de `062`).

-- 1. Les jetons, sous leur vrai nom.
--
-- La table n'a jamais rien eu de « projet » : elle est portée par l'espace
-- depuis le premier jour et sert deux intégrations. Elle s'appelait ainsi parce
-- qu'elle est née dans le module Projets. Les clés étrangères qui la visent
-- (`git_repos`, et la nouvelle table ci-dessous) suivent le nom automatiquement.
--
-- Renommée seulement si l'ancienne est encore là **et** la nouvelle pas encore :
-- les deux conditions, parce qu'un rejeu voit exactement l'inverse.
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
-- ⚠️ **Collation déclarée**, contrairement à presque toutes les migrations qui
-- précèdent. Un `CREATE TABLE` sans clause hérite du défaut de la **base**, qui
-- n'est pas forcément celui de son schéma : ce dépôt est tout entier en
-- `utf8mb4_general_ci`, mais une base créée sur un MySQL 8 récent vaut
-- `utf8mb4_0900_ai_ci` par défaut. La reprise de données plus bas joint une
-- table neuve à une ancienne sur `external_id` ; deux collations différentes de
-- part et d'autre, et la jointure lève `Illegal mix of collations` — au
-- démarrage, hors transaction, à mi-migration. Le rejeu sur copie l'a produit.
CREATE TABLE IF NOT EXISTS deploy_targets (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id  INT          NOT NULL,
    -- NULL = le jeton a été retiré ; la cible reste, indéployable, et le dit —
    -- plutôt que de disparaître avec sa clé.
    credential_id INT          NULL,
    provider      VARCHAR(16)  NOT NULL DEFAULT 'dokploy',
    -- 'application' | 'compose'. Une cible sans son type est indéployable : les
    -- deux n'ont ni la même procédure de déclenchement ni la même d'historique.
    target_kind   VARCHAR(16)  NOT NULL DEFAULT 'application',
    -- Identifiant de la cible chez le fournisseur. **En clair**, et c'est ce qui
    -- permet à l'unicité d'être une vraie contrainte SQL plutôt qu'un condensé
    -- de substitution comme `git_repos.slug_ref` : il n'identifie personne, il
    -- désigne une ressource chez un tiers.
    external_id   VARCHAR(128) NOT NULL,
    -- Rang dans la liste, entièrement défini par l'utilisateur (`deploy.reorder`).
    sort_order    INT          NOT NULL DEFAULT 0,
    -- { name } chiffré, étage ouvert.
    content       TEXT         NOT NULL,
    created       BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    -- Deux fois la même application sur la même instance, c'est la même cible :
    -- c'est ce qui rend `deploy.add` idempotente, et donc ce qui garantit qu'un
    -- projet qui « déclare » une cible déjà connue la retrouve au lieu de la
    -- dupliquer.
    UNIQUE KEY uniq_deploy_target (workspace_id, credential_id, external_id),
    CONSTRAINT fk_deploy_target_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_deploy_target_credential FOREIGN KEY (credential_id) REFERENCES workspace_credentials(id) ON DELETE SET NULL
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 3. La liaison projet → cible.
--
-- Cinquième de la même famille, et la forme est établie : services surveillés
-- (067), bases (068), dépôts (069), sites (077). Non exclusive dans les deux
-- sens. Les trois clés étrangères sont en CASCADE : c'est la **liaison** qui
-- tombe, jamais ce qu'elle relie.
--
-- ⚠️ `fk_pdpl_*` et non `fk_pdl_*` : InnoDB exige des noms de contrainte uniques
-- **par schéma**, pas par table, et `project_database_links` (068) tient déjà
-- `fk_pdl_project` et `fk_pdl_workspace`. C'est l'erreur qui a fait échouer ce
-- fichier à son premier passage. Rien ne l'attrape avant l'exécution : deux
-- fichiers de migration écrits à deux ans d'écart n'ont aucune raison de se
-- relire l'un l'autre, et l'abréviation naturelle est la même.
CREATE TABLE IF NOT EXISTS project_deploy_links (
    project_id   INT    NOT NULL,
    target_id    INT    NOT NULL,
    workspace_id INT    NOT NULL,
    created      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (project_id, target_id),
    -- « Combien de projets déploient cette cible » se lit sur cet index seul,
    -- donc avant qu'on clique sur « Supprimer » — pas après.
    KEY idx_project_deploy_links_target (target_id),
    CONSTRAINT fk_pdpl_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_pdpl_target FOREIGN KEY (target_id) REFERENCES deploy_targets(id) ON DELETE CASCADE,
    CONSTRAINT fk_pdpl_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 4. Les déploiements pendent à la cible, plus au projet.
--
-- `provider` disparaît de cette table : il est celui de la cible, et le recopier
-- ici ouvrait la porte à deux valeurs contradictoires pour un même fait.
--
-- ⚠️ `fk_deployments_*` au pluriel : `project_deployments`, qui vit encore à cet
-- instant du fichier, tient déjà `fk_deployment_workspace` et
-- `fk_deployment_user`. Même piège que ci-dessus.
CREATE TABLE IF NOT EXISTS deployments (
    id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
    target_id            INT          NOT NULL,
    workspace_id         INT          NOT NULL,
    -- Identifiant du déploiement chez le fournisseur, quand il en donne un au
    -- déclenchement — Dokploy ne le fait pas toujours, d'où le rattachement par
    -- proximité de date en second recours (voir `IntegrationSyncService`).
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

-- 5. Reprise des données.
--
-- Les trois reprises ne s'exécutent que si l'ancienne table est encore là : sur
-- un rejeu d'après-succès partiel, elle a pu être supprimée à l'étape 6.
SET @has_old_targets = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
                         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_deploy_targets');
SET @has_old_deployments = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
                             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_deployments');

-- `INSERT IGNORE` porte la fusion : deux projets visant la même application sur
-- la même instance donnaient deux lignes, ils partageront désormais une cible.
-- Il rend aussi l'étape rejouable — la clé d'unicité écarte ce qui est déjà là.
-- L'ordre des `id` suit celui des anciens projets, ce qui donne un `sort_order`
-- nul pour tout le monde : la liste part dans l'ordre d'insertion, et
-- l'utilisateur la range comme il l'entend.
SET @copy_targets = IF(@has_old_targets = 1,
    'INSERT IGNORE INTO deploy_targets (workspace_id, credential_id, provider, target_kind, external_id, content, created)
     SELECT workspace_id, credential_id, provider, target_kind, external_id, content, created
       FROM project_deploy_targets',
    'SELECT 1'
);
PREPARE stmt FROM @copy_targets; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- La liaison se retrouve par (espace, jeton, identifiant externe), le triplet
-- qui vient d'être fusionné. `<=>` et non `=` : un jeton retiré vaut NULL, et
-- `NULL = NULL` est faux. `MIN(t.id)` tranche le cas résiduel où deux cibles
-- sans jeton auraient échappé à la clé d'unicité (MySQL y admet les NULL
-- multiples) : le projet se rattache alors à la première, pas aux deux.
SET @copy_links = IF(@has_old_targets = 1,
    'INSERT IGNORE INTO project_deploy_links (project_id, target_id, workspace_id)
     SELECT o.project_id, MIN(t.id), o.workspace_id
       FROM project_deploy_targets o
       JOIN deploy_targets t
         ON t.workspace_id = o.workspace_id
        AND t.external_id = o.external_id
        AND t.credential_id <=> o.credential_id
      GROUP BY o.project_id, o.workspace_id',
    'SELECT 1'
);
PREPARE stmt FROM @copy_links; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- L'historique suit la cible de son projet. Un déploiement dont le projet
-- n'avait plus de cible — déliée entre-temps — n'a plus rien à quoi pendre : il
-- part avec l'ancienne table, et son fait reste dans la frise du projet, qui
-- l'a enregistré au déclenchement.
--
-- La garde « `deployments` est vide » est ici indispensable et ne se déduit pas
-- de l'existence de l'ancienne table : sans clé d'unicité pour l'arrêter, un
-- rejeu importerait l'historique **une seconde fois**.
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
