-- Déploiement devient un module : ses clés Dokploy quittent
-- `workspace_credentials` (une table à deux propriétaires depuis la 061,
-- distingués par `provider`) pour une table à lui, `ft_deploy_credentials`,
-- au préfixe des modules.
--
-- C'est le socle qui crée la table et copie les lignes, pas une migration du
-- module : au démarrage, les migrations du socle tournent AVANT celles des
-- modules, et une migration de module ne peut pas écrire dans une table du
-- socle (`gen-features` borne ses instructions à son préfixe et à son
-- allowlist). Une seule migration, un seul boot, les gestes dans l'ordre
-- (patron de la 098). Le module possède la table ensuite ; son
-- `uninstall.sql` peut la détruire.
--
-- Les identifiants sont CONSERVÉS : `deploy_targets.credential_id` reste
-- valable tel quel, aucune ligne de cible n'est réécrite.
--
-- La clé étrangère `fk_deploy_target_credential` (080, `ON DELETE SET NULL`)
-- est retirée et N'EST PAS recréée vers la nouvelle table. Répétée sur une
-- copie de la base le 28 août 2026, la suppression d'un espace échouait sur
-- elle : InnoDB revalide la ligne mise à NULL contre un parent que la même
-- cascade est en train de supprimer. Le ménage est désormais explicite, dans
-- le code du module (retirer une clé met à NULL les cibles qui la désignaient),
-- ce que la contrainte faisait sans le dire.
--
-- Rejouable : la table se crée si elle manque, la copie ignore les doublons,
-- la clé étrangère ne se retire que si elle existe, les lignes copiées ne se
-- suppriment qu'après. Une base laissée à mi-chemin se répare en relançant.

CREATE TABLE IF NOT EXISTS ft_deploy_credentials (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    workspace_id INT          NOT NULL,
    -- Étiquette lisible, choisie par l'utilisateur ; en clair, elle ne dit rien
    -- de plus que « quelle clé » et sert à les distinguer dans un sélecteur.
    label        VARCHAR(64)  NOT NULL,
    -- Racine de l'instance Dokploy, auto-hébergée par définition. NULL sur une
    -- ligne d'époque saisie sans adresse ; le module refuse alors de s'en servir.
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
