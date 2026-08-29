-- Le temps de réponse du dernier relevé d'une base, renseigné aussi sur un
-- échec (un relevé qui met douze secondes à échouer dit quelque chose). Une
-- colonne et non le blob `content` : c'est une mesure écrite par le relevé
-- (`recordCheck`), à côté de `last_check_at`, pas un réglage.
--
-- Ajout conditionnel via INFORMATION_SCHEMA + SQL dynamique, jamais
-- `ADD COLUMN IF NOT EXISTS` (extension MariaDB, cf. 038).

SET @db_elapsed_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'database_connections' AND COLUMN_NAME = 'last_elapsed_ms');
SET @add_db_elapsed = IF(@db_elapsed_exists = 0,
    'ALTER TABLE database_connections ADD COLUMN last_elapsed_ms INT NULL AFTER last_check_at',
    'SELECT 1');
PREPARE stmt FROM @add_db_elapsed; EXECUTE stmt; DEALLOCATE PREPARE stmt;
