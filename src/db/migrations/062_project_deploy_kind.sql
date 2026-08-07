-- Type de cible de déploiement : application ou pile compose.
--
-- Constaté sur une instance Dokploy réelle : la majorité des services y sont
-- des piles **compose**, pas des applications. Or les deux n'ont ni la même
-- procédure de déclenchement (`application.deploy` / `compose.deploy`) ni la
-- même procédure d'historique (`deployment.all` / `deployment.allByCompose`).
-- Une cible sans son type est donc indéployable.
--
-- La 061 est déjà passée : on ajoute une migration plutôt que de la retoucher
-- (`_migrations` ne rejoue jamais un nom déjà vu — une retouche serait un no-op
-- silencieux là où elle est déjà appliquée).
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, JAMAIS via
-- `ADD COLUMN IF NOT EXISTS` : cette clause a fait tomber la production au
-- démarrage (voir 038_uptime_order.sql).

SET @kind_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_deploy_targets' AND COLUMN_NAME = 'target_kind');
SET @add_kind = IF(@kind_exists = 0,
    'ALTER TABLE project_deploy_targets ADD COLUMN target_kind VARCHAR(16) NOT NULL DEFAULT ''application'' AFTER provider',
    'SELECT 1');
PREPARE stmt FROM @add_kind; EXECUTE stmt; DEALLOCATE PREPARE stmt;
