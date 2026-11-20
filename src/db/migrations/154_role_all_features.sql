-- Un rôle qui tient toutes les fonctionnalités, celles installées plus tard
-- comprises, au lieu d'une liste figée à son enregistrement. Aucun rôle existant
-- n'est converti : la case se coche dans la popup du rôle. Ajout
-- conditionnel via INFORMATION_SCHEMA.
SET @wr_all_features_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_roles' AND COLUMN_NAME = 'all_features');
SET @add_wr_all_features = IF(@wr_all_features_exists = 0,
    'ALTER TABLE workspace_roles ADD COLUMN all_features TINYINT NOT NULL DEFAULT 0 AFTER features',
    'SELECT 1');
PREPARE stmt FROM @add_wr_all_features; EXECUTE stmt; DEALLOCATE PREPARE stmt;
