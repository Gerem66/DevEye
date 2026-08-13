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

-- 1. Les jetons, sous leur vrai nom.
--
-- La table n'a jamais rien eu de « projet » : elle est portée par l'espace
-- depuis le premier jour et sert deux intégrations. Elle s'appelait ainsi parce
-- qu'elle est née dans le module Projets. Les clés étrangères qui la visent
-- (`git_repos`, et la nouvelle table ci-dessous) suivent le nom automatiquement.
RENAME TABLE project_credentials TO workspace_credentials;

-- 2. La cible, portée par l'espace.
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
);

-- 3. La liaison projet → cible.
--
-- Cinquième de la même famille, et la forme est établie : services surveillés
-- (067), bases (068), dépôts (069), sites (077). Non exclusive dans les deux
-- sens. Les trois clés étrangères sont en CASCADE : c'est la **liaison** qui
-- tombe, jamais ce qu'elle relie.
CREATE TABLE IF NOT EXISTS project_deploy_links (
    project_id   INT    NOT NULL,
    target_id    INT    NOT NULL,
    workspace_id INT    NOT NULL,
    created      BIGINT NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    PRIMARY KEY (project_id, target_id),
    -- « Combien de projets déploient cette cible » se lit sur cet index seul,
    -- donc avant qu'on clique sur « Supprimer » — pas après.
    KEY idx_project_deploy_links_target (target_id),
    CONSTRAINT fk_pdl_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_pdl_target FOREIGN KEY (target_id) REFERENCES deploy_targets(id) ON DELETE CASCADE,
    CONSTRAINT fk_pdl_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- 4. Les déploiements pendent à la cible, plus au projet.
--
-- `provider` disparaît de cette table : il est celui de la cible, et le recopier
-- ici ouvrait la porte à deux valeurs contradictoires pour un même fait.
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
    CONSTRAINT fk_deployment_target FOREIGN KEY (target_id) REFERENCES deploy_targets(id) ON DELETE CASCADE,
    CONSTRAINT fk_deployment_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT fk_deployment_user FOREIGN KEY (triggered_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- 5. Reprise des données.
--
-- `INSERT IGNORE` porte la fusion : deux projets visant la même application sur
-- la même instance donnaient deux lignes, ils partageront désormais une cible.
-- L'ordre des `id` suit celui des anciens projets, ce qui donne un `sort_order`
-- nul pour tout le monde — la liste part donc dans l'ordre d'insertion, et
-- l'utilisateur la range comme il l'entend.
INSERT IGNORE INTO deploy_targets (workspace_id, credential_id, provider, target_kind, external_id, content, created)
SELECT workspace_id, credential_id, provider, target_kind, external_id, content, created
  FROM project_deploy_targets;

-- La liaison se retrouve par (espace, jeton, identifiant externe), le triplet
-- qui vient d'être fusionné. `<=>` et non `=` : un jeton retiré vaut NULL, et
-- `NULL = NULL` est faux. `MIN(t.id)` tranche le cas résiduel où deux cibles
-- sans jeton auraient échappé à la clé d'unicité (MySQL y admet les NULL
-- multiples) : le projet se rattache alors à la première, pas aux deux.
INSERT IGNORE INTO project_deploy_links (project_id, target_id, workspace_id)
SELECT o.project_id, MIN(t.id), o.workspace_id
  FROM project_deploy_targets o
  JOIN deploy_targets t
    ON t.workspace_id = o.workspace_id
   AND t.external_id = o.external_id
   AND t.credential_id <=> o.credential_id
 GROUP BY o.project_id, o.workspace_id;

-- L'historique suit la cible de son projet. Un déploiement dont le projet
-- n'avait plus de cible — délié entre-temps — n'a plus rien à quoi pendre : il
-- part avec l'ancienne table, et son fait reste dans la frise du projet, qui
-- l'a enregistré au déclenchement.
INSERT INTO deployments
    (target_id, workspace_id, external_id, status, triggered_by_user_id, started_at, finished_at, content)
SELECT l.target_id, d.workspace_id, d.external_id, d.status, d.triggered_by_user_id,
       d.started_at, d.finished_at, d.content
  FROM project_deployments d
  JOIN project_deploy_links l ON l.project_id = d.project_id
 ORDER BY d.id;

-- 6. L'ancien monde. Les FK partent avec les tables.
DROP TABLE IF EXISTS project_deployments;
DROP TABLE IF EXISTS project_deploy_targets;
