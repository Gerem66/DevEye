-- Git devient un module : ses jetons GitHub quittent `workspace_credentials`
-- pour `ft_git_credentials`, et la table commune disparaît (Déploiement a
-- emporté ses clés Dokploy dans la 099).
--
-- C'est le socle qui crée la table, copie les lignes et supprime l'ancienne :
-- les migrations du socle tournent AVANT celles des modules, et une migration
-- de module ne peut ni lire ni détruire une table du socle (patron de la 098).
-- Les identifiants sont CONSERVÉS : `git_repos.credential_id` reste valable tel
-- quel. Pas de `base_url` : l'API GitHub est publique.
--
-- La clé étrangère `fk_git_repo_credential` (064, `ON DELETE SET NULL`) est
-- retirée et N'EST PAS recréée : même piège InnoDB que pour les cibles de
-- déploiement (099). Le ménage est explicite dans le module.
--
-- Rejouable : table créée si elle manque, copie qui ignore les doublons, FK
-- retirée si elle existe, table commune supprimée après la copie.

CREATE TABLE IF NOT EXISTS ft_git_credentials (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id INT         NOT NULL,
    -- Étiquette lisible, en clair : elle ne dit rien de plus que « quel jeton ».
    label        VARCHAR(64) NOT NULL,
    -- Le jeton, chiffré à l'étage ouvert. Jamais renvoyé au client.
    secret_enc   TEXT        NOT NULL,
    created      BIGINT      NOT NULL DEFAULT (UNIX_TIMESTAMP()),
    KEY idx_ft_git_credentials_workspace (workspace_id),
    CONSTRAINT fk_ft_git_credentials_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

SET @has_old = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_credentials');

SET @s = IF(@has_old > 0,
    'INSERT IGNORE INTO ft_git_credentials (id, workspace_id, label, secret_enc, created)
     SELECT id, workspace_id, label, secret_enc, created
       FROM workspace_credentials WHERE provider = ''github''',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- La clé étrangère part AVANT la table qu'elle vise : sans cela, le DROP
-- serait refusé, ou mettrait à NULL les dépôts qu'on vient de préserver.
SET @has_fk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'git_repos'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND CONSTRAINT_NAME = 'fk_git_repo_credential');
SET @s = IF(@has_fk > 0, 'ALTER TABLE git_repos DROP FOREIGN KEY fk_git_repo_credential', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

DROP TABLE IF EXISTS workspace_credentials;
