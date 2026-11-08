-- Pause d'un agent (depuis l'app, `deveye-agent pause` ou l'icône) : l'instant
-- où il s'est annoncé en pause, et celui où elle finit d'elle-même (NULL tant
-- qu'elle attend une reprise). Ajout conditionnel via INFORMATION_SCHEMA.
SET @dev_paused_at_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'paused_at');
SET @add_dev_paused_at = IF(@dev_paused_at_exists = 0,
    'ALTER TABLE devices ADD COLUMN paused_at BIGINT NULL DEFAULT NULL AFTER delete_error, ADD COLUMN paused_until BIGINT NULL DEFAULT NULL AFTER paused_at',
    'SELECT 1');
PREPARE stmt FROM @add_dev_paused_at; EXECUTE stmt; DEALLOCATE PREPARE stmt;
