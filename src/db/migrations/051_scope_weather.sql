-- Meteo passe au scope espace.
--
-- Deux tables : les lieux, et les cles d'API par fournisseur (singleton compose,
-- dont la cle primaire suit le meme changement que les autres reglages).
--
-- Attention particuliere a `is_primary` : « le lieu principal » etait unique par
-- compte, il devient unique par espace. Sans re-derivation, deux membres d'un
-- meme espace partage y auraient chacun le leur, et l'affichage en choisirait un
-- au hasard.

-- 1. weather_locations.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'weather_locations' AND COLUMN_NAME = 'workspace_id');
SET @s = IF(@c = 0, 'ALTER TABLE weather_locations ADD COLUMN workspace_id INT NULL AFTER user_id', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE weather_locations l
JOIN users u ON u.id = l.user_id
SET l.workspace_id = u.personal_workspace_id
WHERE l.workspace_id IS NULL;

ALTER TABLE weather_locations MODIFY COLUMN workspace_id INT NOT NULL;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'weather_locations'
            AND INDEX_NAME = 'idx_weather_workspace');
SET @s = IF(@c = 0, 'ALTER TABLE weather_locations ADD KEY idx_weather_workspace (workspace_id)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'weather_locations'
            AND CONSTRAINT_NAME = 'fk_weather_workspace');
SET @s = IF(@c = 0,
    'ALTER TABLE weather_locations ADD CONSTRAINT fk_weather_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Ordre d'affichage renumerote par espace.
UPDATE weather_locations l
JOIN (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY position ASC, created ASC, id ASC) - 1 AS rn
    FROM weather_locations
) r ON r.id = l.id
SET l.position = r.rn;

-- Un seul lieu principal par espace : le premier de l'ordre parmi ceux qui
-- l'etaient deja, sinon aucun. On ne « promeut » pas un lieu qui ne l'etait pas.
UPDATE weather_locations l
LEFT JOIN (
    SELECT workspace_id, MIN(position) AS keep_position
    FROM weather_locations WHERE is_primary = 1 GROUP BY workspace_id
) k ON k.workspace_id = l.workspace_id
SET l.is_primary = IF(l.is_primary = 1 AND l.position = k.keep_position, 1, 0);

-- 2. weather_provider_keys : cle primaire (compte, fournisseur) -> (espace, fournisseur).
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'weather_provider_keys' AND COLUMN_NAME = 'workspace_id');
SET @s = IF(@c = 0, 'ALTER TABLE weather_provider_keys ADD COLUMN workspace_id INT NULL FIRST', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'weather_provider_keys' AND COLUMN_NAME = 'user_id');
SET @s = IF(@c > 0,
    'UPDATE weather_provider_keys k JOIN users u ON u.id = k.user_id SET k.workspace_id = u.personal_workspace_id WHERE k.workspace_id IS NULL',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = IF(@c > 0, 'DELETE FROM weather_provider_keys WHERE workspace_id IS NULL', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE weather_provider_keys MODIFY COLUMN workspace_id INT NOT NULL;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'weather_provider_keys'
            AND CONSTRAINT_NAME = 'fk_weatherkey_user');
SET @s = IF(@c > 0, 'ALTER TABLE weather_provider_keys DROP FOREIGN KEY fk_weatherkey_user', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'weather_provider_keys' AND COLUMN_NAME = 'user_id');
SET @s = IF(@c > 0,
    'ALTER TABLE weather_provider_keys DROP PRIMARY KEY, ADD PRIMARY KEY (workspace_id, provider), DROP COLUMN user_id',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'weather_provider_keys'
            AND CONSTRAINT_NAME = 'fk_weatherkey_workspace');
SET @s = IF(@c = 0,
    'ALTER TABLE weather_provider_keys ADD CONSTRAINT fk_weatherkey_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
