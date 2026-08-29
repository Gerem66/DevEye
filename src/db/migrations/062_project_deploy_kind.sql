-- Type de cible de déploiement : application ou pile compose. Les deux n'ont
-- ni la même procédure de déclenchement (`application.deploy` /
-- `compose.deploy`) ni la même d'historique : une cible sans son type est
-- indéployable.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB, cf. 038).

SET @kind_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_deploy_targets' AND COLUMN_NAME = 'target_kind');
SET @add_kind = IF(@kind_exists = 0,
    'ALTER TABLE project_deploy_targets ADD COLUMN target_kind VARCHAR(16) NOT NULL DEFAULT ''application'' AFTER provider',
    'SELECT 1');
PREPARE stmt FROM @add_kind; EXECUTE stmt; DEALLOCATE PREPARE stmt;
