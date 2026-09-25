-- Une colonne `landing_tab` sur `projects`, posee par une migration
-- `007_project_landing_tab.sql` jamais versionnee : aucun code ne la lit ni ne
-- l'ecrit, et toutes ses lignes portent sa valeur par defaut.
--
-- Rejouable : la suppression est gardee par INFORMATION_SCHEMA.

SET @has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'projects'
              AND COLUMN_NAME = 'landing_tab');
SET @s = IF(@has = 1, 'ALTER TABLE projects DROP COLUMN landing_tab', 'SELECT 1');
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
