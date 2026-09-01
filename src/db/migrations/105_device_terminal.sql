-- Le terminal distant se règle appareil par appareil, et non plus navigateur
-- par navigateur : le compte sous lequel la session s'ouvre et ce que fait la
-- fermeture du shell rejoignent la ligne, comme la cadence de collecte. Un
-- appareil partagé porte donc ses réglages de terminal dans tous les espaces
-- qui le voient.
--
-- Rejouable : chaque ajout est gardé par la lecture d'INFORMATION_SCHEMA.

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices'
            AND COLUMN_NAME = 'terminal_default_user');
SET @s = IF(@c = 0,
    'ALTER TABLE devices ADD COLUMN terminal_default_user VARCHAR(32) NULL AFTER retention_days',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices'
            AND COLUMN_NAME = 'terminal_close_on_exit');
SET @s = IF(@c = 0,
    'ALTER TABLE devices ADD COLUMN terminal_close_on_exit TINYINT NOT NULL DEFAULT 1 AFTER terminal_default_user',
    'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
