-- Les appareils sont rattaches a un espace. `owner_id` est CONSERVE (qui a
-- appaire la machine, pour l'attribution et l'audit) mais cesse d'etre la
-- frontiere d'acces. Les tables filles passent par `device_id`. Rien n'est
-- chiffre par une DEK cote appareils : aucun effet cryptographique.

-- 1. devices.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'workspace_id');
SET @s = IF(@c = 0, 'ALTER TABLE devices ADD COLUMN workspace_id INT NULL AFTER owner_id', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE devices d
JOIN users u ON u.id = d.owner_id
SET d.workspace_id = u.personal_workspace_id
WHERE d.workspace_id IS NULL;

ALTER TABLE devices MODIFY COLUMN workspace_id INT NOT NULL;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND INDEX_NAME = 'idx_devices_workspace');
SET @s = IF(@c = 0, 'ALTER TABLE devices ADD KEY idx_devices_workspace (workspace_id)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices'
            AND CONSTRAINT_NAME = 'fk_device_workspace');
SET @s = IF(@c = 0,
    'ALTER TABLE devices ADD CONSTRAINT fk_device_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- L'unicite « une machine appairee une fois » se mesure par espace : le
-- re-appairage (`findByWorkspaceFingerprint`) doit retrouver la ligne de
-- l'espace vise. Une meme machine peut donc etre appairee une fois par espace.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND INDEX_NAME = 'uniq_workspace_fingerprint');
SET @s = IF(@c = 0,
    'ALTER TABLE devices ADD UNIQUE KEY uniq_workspace_fingerprint (workspace_id, fingerprint)',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- L'ancien index doit partir APRES le nouveau : `fk_device_owner` s'appuie sur
-- un index commencant par `owner_id`, et `idx_devices_owner` prend le relais.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND INDEX_NAME = 'uniq_owner_fingerprint');
SET @s = IF(@c > 0, 'ALTER TABLE devices DROP INDEX uniq_owner_fingerprint', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. device_link_codes : le code porte l'espace de destination, sinon
--    l'enrolement (route publique, sans session) ne saurait pas ou ranger la
--    machine. `user_id` reste : c'est l'emetteur du code.
SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_link_codes' AND COLUMN_NAME = 'workspace_id');
SET @s = IF(@c = 0, 'ALTER TABLE device_link_codes ADD COLUMN workspace_id INT NULL AFTER user_id', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE device_link_codes c
JOIN users u ON u.id = c.user_id
SET c.workspace_id = u.personal_workspace_id
WHERE c.workspace_id IS NULL;

-- Un code dont l'emetteur a disparu n'est plus consommable.
DELETE FROM device_link_codes WHERE workspace_id IS NULL;

ALTER TABLE device_link_codes MODIFY COLUMN workspace_id INT NOT NULL;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_link_codes'
            AND CONSTRAINT_NAME = 'fk_linkcode_workspace');
SET @s = IF(@c = 0,
    'ALTER TABLE device_link_codes ADD CONSTRAINT fk_linkcode_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
