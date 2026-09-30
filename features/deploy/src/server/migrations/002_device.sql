-- Un accès Dokploy peut passer par l'agent d'un appareil : son instance n'est
-- alors joignable que depuis la machine. On garde l'appareil et le membre qui
-- l'a choisi, dont le droit sur l'appareil est revérifié à chaque usage.
--
-- Rejouable : chaque ajout est gardé par l'état lu dans INFORMATION_SCHEMA.

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_deploy_credentials' AND COLUMN_NAME = 'device_id');
SET @s = IF(@c = 0,
    'ALTER TABLE ft_deploy_credentials ADD COLUMN device_id CHAR(36) NULL AFTER base_url',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- La clé étrangère exige la collation de `devices.id`, qui suit le défaut de la
-- base, quand celle de la table peut en différer.
SELECT CHARACTER_SET_NAME, COLLATION_NAME INTO @dev_charset, @dev_collation
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'id';
SET @col_collation = (SELECT COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS
                       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_deploy_credentials' AND COLUMN_NAME = 'device_id');
SET @s = IF(@col_collation <> @dev_collation,
    CONCAT('ALTER TABLE ft_deploy_credentials MODIFY COLUMN device_id CHAR(36) CHARACTER SET ', @dev_charset,
           ' COLLATE ', @dev_collation, ' NULL'),
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_deploy_credentials'
             AND CONSTRAINT_NAME = 'fk_ft_deploy_credentials_device');
SET @s = IF(@c = 0,
    'ALTER TABLE ft_deploy_credentials ADD CONSTRAINT fk_ft_deploy_credentials_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE SET NULL',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_deploy_credentials' AND COLUMN_NAME = 'author_user_id');
SET @s = IF(@c = 0,
    'ALTER TABLE ft_deploy_credentials ADD COLUMN author_user_id INT NULL AFTER device_id',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_deploy_credentials'
             AND CONSTRAINT_NAME = 'fk_ft_deploy_credentials_author');
SET @s = IF(@c = 0,
    'ALTER TABLE ft_deploy_credentials ADD CONSTRAINT fk_ft_deploy_credentials_author FOREIGN KEY (author_user_id) REFERENCES users (id) ON DELETE SET NULL',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
