-- Combien de temps un code d'application saisi garde les machines pilotables
-- sans le redemander, en secondes, glissant à chaque action sur une machine.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB).

SET @users_step_up_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'step_up_interval');
SET @add_users_step_up = IF(@users_step_up_exists = 0,
    'ALTER TABLE users ADD COLUMN step_up_interval INT UNSIGNED NOT NULL DEFAULT 900 AFTER re_auth_interval',
    'SELECT 1');
PREPARE stmt FROM @add_users_step_up; EXECUTE stmt; DEALLOCATE PREPARE stmt;
