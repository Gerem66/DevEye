-- Déploiement devient un module : ses clés Dokploy quittent
-- `workspace_credentials` (deux propriétaires distingués par `provider`) pour
-- `ft_deploy_credentials`.
--
-- C'est le socle qui crée la table et copie les lignes : les migrations du socle
-- tournent AVANT celles des modules, et une migration de module ne peut pas
-- écrire dans une table du socle (patron de la 098). Les identifiants sont
-- CONSERVÉS : `deploy_targets.credential_id` reste valable tel quel.
--
-- La clé étrangère `fk_deploy_target_credential` (080, `ON DELETE SET NULL`)
-- est retirée et N'EST PAS recréée : la suppression d'un espace échouait sur
-- elle, InnoDB revalidant la ligne mise à NULL contre un parent que la même
-- cascade est en train de supprimer. Le ménage est explicite dans le module.
--
-- Rejouable : table créée si elle manque, copie qui ignore les doublons, FK
-- retirée si elle existe, lignes copiées supprimées après.

CREATE TABLE IF NOT EXISTS ft_deploy_credentials (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id INT          NOT NULL,
    -- Étiquette lisible, en clair : elle ne dit rien de plus que « quelle clé ».
    label        VARCHAR(64)  NOT NULL,
    -- Racine de l'instance Dokploy. NULL sur une ligne d'époque saisie sans
    -- adresse : le module refuse alors de s'en servir.
    base_url     VARCHAR(255) NULL,
    -- La clé d'API, chiffrée à l'étage ouvert. Jamais renvoyée au client.
    secret_enc   TEXT         NOT NULL,
    created      BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_ft_deploy_credentials_workspace (workspace_id),
    CONSTRAINT fk_ft_deploy_credentials_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

SET @has_old = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_credentials');

SET @s = IF(@has_old > 0,
    'INSERT IGNORE INTO ft_deploy_credentials (id, workspace_id, label, base_url, secret_enc, created)
     SELECT id, workspace_id, label, base_url, secret_enc, created
       FROM workspace_credentials WHERE provider = ''dokploy''',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- La clé étrangère part AVANT les lignes copiées : la supprimer après aurait
-- mis à NULL, par la contrainte, toutes les cibles qu'on vient de préserver.
SET @has_fk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deploy_targets'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND CONSTRAINT_NAME = 'fk_deploy_target_credential');
SET @s = IF(@has_fk > 0, 'ALTER TABLE deploy_targets DROP FOREIGN KEY fk_deploy_target_credential', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF(@has_old > 0, 'DELETE FROM workspace_credentials WHERE provider = ''dokploy''', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
