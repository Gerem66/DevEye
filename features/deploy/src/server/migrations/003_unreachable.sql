-- Le lien perdu avec l'instance d'un accès : depuis quand, la cause telle que
-- le fournisseur ou le relais l'a dite, et si un canal a accepté l'avis (le
-- retour ne se dit qu'à qui a entendu la perte). Tout à NULL ou 0 : le lien
-- tient.
--
-- Rejouable : chaque ajout est gardé par l'état lu dans INFORMATION_SCHEMA.

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_deploy_credentials' AND COLUMN_NAME = 'unreachable_since');
SET @s = IF(@c = 0,
    'ALTER TABLE ft_deploy_credentials ADD COLUMN unreachable_since BIGINT NULL AFTER secret_enc',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_deploy_credentials' AND COLUMN_NAME = 'unreachable_error');
SET @s = IF(@c = 0,
    'ALTER TABLE ft_deploy_credentials ADD COLUMN unreachable_error VARCHAR(255) NULL AFTER unreachable_since',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_deploy_credentials' AND COLUMN_NAME = 'unreachable_notified');
SET @s = IF(@c = 0,
    'ALTER TABLE ft_deploy_credentials ADD COLUMN unreachable_notified TINYINT(1) NOT NULL DEFAULT 0 AFTER unreachable_error',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
