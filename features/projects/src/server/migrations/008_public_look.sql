-- L'allure de la page publique d'un projet (theme et accent, choisis comme
-- ceux des pages de reservation), et le depli des sous-taches au clic.
--
-- `theme` vaut `auto` par defaut : la page suit le visiteur, comme avant.
-- `accent` est un nom de couleur de profil, un `#rrggbb`, ou vide pour l'accent
-- d'origine de la page.
--
-- Rejouable : chaque ajout de colonne est garde par INFORMATION_SCHEMA.

SET @has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'ft_projects_public'
              AND COLUMN_NAME = 'theme');
SET @s = IF(@has = 0,
    'ALTER TABLE ft_projects_public ADD COLUMN theme VARCHAR(8) NOT NULL DEFAULT ''auto'' AFTER show_assignees',
    'SELECT 1');
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'ft_projects_public'
              AND COLUMN_NAME = 'accent');
SET @s = IF(@has = 0,
    'ALTER TABLE ft_projects_public ADD COLUMN accent VARCHAR(32) NOT NULL DEFAULT '''' AFTER theme',
    'SELECT 1');
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'ft_projects_public'
              AND COLUMN_NAME = 'show_subtasks');
SET @s = IF(@has = 0,
    'ALTER TABLE ft_projects_public ADD COLUMN show_subtasks TINYINT(1) NOT NULL DEFAULT 0 AFTER show_assignees',
    'SELECT 1');
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
